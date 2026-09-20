// Siembra un entorno de desarrollo utilizable: la plataforma, una cuenta con una
// empresa recien creada y un usuario por cada rol.
//
// No es un script de produccion. Deja usuarios de mentira con nombres de mentira
// dentro de una cuenta que se llama "Demo": contra una base real ensuciaria el
// listado de administracion. Por eso se niega a correr con NODE_ENV=production.
//
// Lo que crea:
//
//   Super administrador   directo contra la base, con la conexion de
//                         aprovisionamiento. No hay endpoint a proposito: una
//                         pantalla para crear super admins es justo la puerta que
//                         no debe existir (ver 0011_plataforma.sql).
//   Cuenta + ADMIN_TENANT POST /tenants, igual que crear-cuenta.js.
//   Empresa               POST /empresas, con lo minimo que el endpoint exige.
//                         Sin sedes, sin situacion legal, sin DIAN: la
//                         configuracion la hace quien entra, y verla a medias es
//                         justamente lo que hay que poder probar.
//   Un usuario por rol    uno por cada rol de ambito EMPRESA del catalogo `rol`,
//                         leido de la base: si manana hay un rol mas, aparece
//                         aca solo.
//
// Las contrasenas se generan y se muestran una sola vez. Ninguna queda escrita.
//
// Uso:
//   node scripts/sembrar.js                      la API tiene que estar arriba
//   node scripts/sembrar.js --password "MiClaveDeDesarrollo"
//   node scripts/sembrar.js --sufijo 2           un juego aparte, desechable
//   node scripts/sembrar.js --dominio acme.co    otro dominio de correo
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const { hash } = require('@node-rs/argon2');

const BASE = `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;

function argumentos() {
  const args = process.argv.slice(2);
  const valores = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const clave = args[i].slice(2);
    const siguiente = args[i + 1];
    valores[clave] = siguiente && !siguiente.startsWith('--') ? siguiente : true;
    if (valores[clave] !== true) i += 1;
  }
  return valores;
}

// 18 bytes en base64url: entropia de sobra, y todavia se puede dictar por
// telefono. Supera los 12 caracteres que exige CrearUsuarioDto.
const generarClave = () => crypto.randomBytes(18).toString('base64url');

async function pedir(metodo, ruta, { token, cuerpo, cabeceras } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  return { estado: res.status, datos };
}

function exigir(res, esperado, que) {
  if (res.estado !== esperado) {
    console.error(`\n  Fallo al ${que} (HTTP ${res.estado}):`);
    console.error('  ' + JSON.stringify(res.datos));
    process.exit(1);
  }
  return res.datos;
}

// Nombres propios para que el listado de usuarios se lea como uno de verdad y no
// como "usuario1, usuario2". Que rol ejerce cada uno sale del catalogo, no de aca.
const PERSONAS = {
  ADMIN_TENANT: 'Ana Torres',
  DIRECTOR: 'Luisa Pena Gomez',
  CONTADOR: 'Carlos Rueda Mejia',
  VENTAS: 'Mariana Ospina Ruiz',
  COMPRAS: 'Julian Castano Vera',
  INVENTARIO: 'Diego Marroquin Salas',
  CAJA: 'Paula Jaramillo Nieto',
  CONSULTA: 'Esteban Villa Arango',
};

const nombreDe = (rol) =>
  PERSONAS[rol] ?? rol.charAt(0) + rol.slice(1).toLowerCase().replace(/_/g, ' ');

(async () => {
  const a = argumentos();

  if ((process.env.NODE_ENV || 'development') === 'production') {
    console.error('Este script no corre en produccion: siembra datos de mentira.');
    process.exit(1);
  }
  if (!process.env.CLAVE_PROVISION) {
    console.error('Falta CLAVE_PROVISION en el entorno.');
    process.exit(1);
  }

  // El sufijo permite un segundo juego sin chocar con el primero. Sin el, los
  // correos y el slug son estables: se vuelve a entrar con lo mismo de ayer.
  const sufijo = typeof a.sufijo === 'string' ? `-${a.sufijo}` : '';
  const dominio = typeof a.dominio === 'string' ? a.dominio : 'demo.co';
  const slug = `demo${sufijo}`;
  const correo = (local) => `${local}${sufijo}@${dominio}`.toLowerCase();

  // Una sola clave para los usuarios de la cuenta: es un entorno de desarrollo y
  // van a entrar y salir de todas. La del super admin va aparte a proposito
  // —administrar el producto y llevar una contabilidad son dos cosas distintas, y
  // sus credenciales no se comparten ni en desarrollo.
  const claveUsuarios = typeof a.password === 'string' ? a.password : generarClave();
  const claveSuperAdmin = generarClave();

  if (claveUsuarios.length < 12) {
    console.error('La contrasena tiene que tener 12 caracteres o mas.');
    process.exit(1);
  }

  const salud = await pedir('GET', '/salud').catch(() => ({ estado: 0 }));
  if (salud.estado !== 200) {
    console.error(`La API no responde en ${BASE}. Levantala con: yarn start:dev`);
    process.exit(1);
  }
  if (salud.datos?.base?.aislamientoActivo !== true) {
    console.warn(
      `\n  Aviso: la API corre como ${salud.datos?.base?.usuario} y el aislamiento` +
        ' entre empresas NO esta activo. Revisar DB_APP_USERNAME.\n',
    );
  }

  const db = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_PROVISION_USERNAME || process.env.DB_USERNAME,
    password: process.env.DB_PROVISION_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();

  try {
    // Los roles de empresa salen del catalogo: es la misma lista que valida la
    // base, y no hay una segunda copia que se desactualice.
    const { rows: roles } = await db.query(
      `SELECT codigo FROM rol WHERE ambito = 'EMPRESA' ORDER BY codigo`,
    );
    if (roles.length === 0) {
      console.error('No hay roles de ambito EMPRESA: faltan las migraciones.');
      process.exit(1);
    }

    // Comprobar antes de escribir nada: sembrar a medias deja una cuenta con la
    // mitad de los usuarios y sin forma de saber cuales faltaron.
    //
    // El super admin no entra en la comprobacion: `limpiar-pruebas.js` borra la
    // cuenta pero no toca `plataforma_admin` —no cuelga de ningun tenant—, asi
    // que despues de una limpieza su fila sigue ahi. Se le renueva la contrasena
    // mas abajo en vez de dar todo por sembrado.
    const correos = [
      correo('admin'),
      ...roles.map((r) => correo(r.codigo.toLowerCase())),
    ];
    const { rows: chocan } = await db.query(
      `SELECT email::text AS que FROM usuario        WHERE email = ANY($1)
       UNION
       SELECT 'la cuenta ' || slug::text FROM tenant WHERE slug = $2`,
      [correos, slug],
    );
    if (chocan.length > 0) {
      console.error('\n  Esto ya esta sembrado. Choca con:\n');
      chocan.forEach((c) => console.error(`    ${c.que}`));
      console.error('\n  Opciones: --sufijo 2 para otro juego, o');
      console.error('            node scripts/limpiar-pruebas.js --confirmar\n');
      process.exit(1);
    }

    console.log(`\n  Sembrando contra ${BASE}\n`);

    // -----------------------------------------------------------------------
    // 1 · El super administrador. Directo a la base: no hay endpoint.
    // -----------------------------------------------------------------------
    const { rowCount: renovado } = await db.query(
      `UPDATE plataforma_admin SET hash_password = $2, activo = true WHERE email = $1`,
      [correo('superadmin'), await hash(claveSuperAdmin)],
    );
    if (renovado === 0) {
      await db.query(
        `INSERT INTO plataforma_admin (email, nombre_completo, hash_password)
         VALUES ($1, $2, $3)`,
        [correo('superadmin'), 'Administrador de la plataforma', await hash(claveSuperAdmin)],
      );
    }
    console.log(
      `  1 · super administrador de la plataforma${renovado > 0 ? ' (ya existia: contrasena renovada)' : ''}`,
    );

    // -----------------------------------------------------------------------
    // 2 · La cuenta y su administrador. Por la API y con la clave de
    //     aprovisionamiento: las mismas reglas que al vender el sistema.
    // -----------------------------------------------------------------------
    exigir(
      await pedir('POST', '/tenants', {
        cabeceras: { 'x-clave-provision': process.env.CLAVE_PROVISION },
        cuerpo: {
          nombre: `Demo${sufijo ? ' ' + sufijo.slice(1) : ''}`,
          slug,
          plan: 'EMPRESARIAL',
          maxEmpresas: 5,
          // Los de abajo mas el administrador, con aire para invitar a alguien mas.
          maxUsuarios: roles.length + 5,
          email: correo('admin'),
          nombreAdministrador: PERSONAS.ADMIN_TENANT,
          password: claveUsuarios,
        },
      }),
      201,
      'crear la cuenta',
    );
    console.log('  2 · cuenta "Demo" y su ADMIN_TENANT');

    const sesion = exigir(
      await pedir('POST', '/auth/login', {
        cuerpo: { email: correo('admin'), password: claveUsuarios },
      }),
      200,
      'entrar como el administrador',
    );

    // -----------------------------------------------------------------------
    // 3 · La empresa, recien nacida. Solo lo que el endpoint exige.
    // -----------------------------------------------------------------------
    // Sin sectores, sin forma asociativa, sin moneda ni mes de cierre: todo eso
    // es opcional y forzarlo aca seria adivinar. El DV tampoco se inventa —lo
    // verifica la base y rechaza el que no cuadre—: 8 es el de 900123456.
    const empresa = exigir(
      await pedir('POST', '/empresas', {
        token: sesion.token,
        cuerpo: {
          tipoPersona: 'JURIDICA',
          razonSocial: 'Empresa Demo S.A.S.',
          nit: '900123456',
          dv: '8',
          grupoNiif: 'GRUPO_2',
          fechaInicioOperaciones: `${new Date().getFullYear()}-01-01`,
        },
      }),
      201,
      'crear la empresa',
    );
    console.log('  3 · empresa "Empresa Demo S.A.S." sin configurar');

    // -----------------------------------------------------------------------
    // 4 · Un usuario por rol, cada uno con acceso a la empresa.
    // -----------------------------------------------------------------------
    // Van por POST /usuarios y no por INSERT: asi pasan por el cupo de la
    // suscripcion, el hasheo argon2 y el trigger que separa los roles de tenant
    // de los de empresa. Sembrar por debajo de la API es sembrar algo que la API
    // no habria aceptado.
    for (const { codigo } of roles) {
      exigir(
        await pedir('POST', '/usuarios', {
          token: sesion.token,
          cuerpo: {
            email: correo(codigo.toLowerCase()),
            nombreCompleto: nombreDe(codigo),
            password: claveUsuarios,
            accesos: [{ empresaId: empresa.id, rol: codigo }],
          },
        }),
        201,
        `crear el usuario ${codigo}`,
      );
    }
    console.log(`  4 · ${roles.length} usuarios, uno por rol de empresa`);

    // El administrador de la cuenta quedo ademas como DIRECTOR de la empresa que
    // creo: es quien la abrio. El usuario DIRECTOR de arriba existe igual, para
    // poder probar el rol sin la cuenta encima.
    const trabajo = exigir(
      await pedir('POST', '/auth/empresa', {
        token: sesion.token,
        cuerpo: { empresaId: empresa.id },
      }),
      200,
      'elegir la empresa',
    );
    const estado = await pedir('GET', '/empresas/actual/estado-configuracion', {
      token: trabajo.token,
    });

    // -----------------------------------------------------------------------
    const ancho = Math.max(...roles.map((r) => r.codigo.length), 12);
    const linea = (rol, texto) => `    ${rol.padEnd(ancho)}  ${texto}`;

    console.log('\n  Listo.\n');
    console.log(`  Cuenta         Demo (${slug}) · plan EMPRESARIAL`);
    console.log('  Empresa        Empresa Demo S.A.S. · NIT 900123456-8');
    console.log(
      `  Configuracion  ${estado.datos?.porcentaje ?? '?'} % · siguiente paso: ${estado.datos?.siguiente ?? '?'}`,
    );
    console.log('\n  Credenciales — se muestran una sola vez:\n');
    console.log(`  Contrasena de todos los usuarios de la cuenta:  ${claveUsuarios}\n`);
    console.log(linea('ADMIN_TENANT', correo('admin')));
    roles.forEach((r) => console.log(linea(r.codigo, correo(r.codigo.toLowerCase()))));
    console.log('\n  Super administrador de la plataforma — clave aparte:\n');
    console.log(linea('PLATAFORMA', correo('superadmin')));
    console.log(linea('contrasena', claveSuperAdmin));
    console.log('\n  El login es uno solo: http://localhost:3000/login\n');
  } catch (e) {
    console.error('\n  Fallo:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
})();
