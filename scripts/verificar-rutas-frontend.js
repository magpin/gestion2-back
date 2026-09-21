// Comprueba que cada ruta que llama el frontend exista y responda.
//
// Un 404 acá es un nombre de endpoint que se escribió distinto en los dos lados,
// y es el error mas caro de encontrar en el navegador: se ve como un formulario
// que no guarda, sin decir por que.
require('dotenv').config();
const crypto = require('crypto');

const BASE = `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;
const marca = Date.now();

let fallidas = 0;

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

function revisar(res, descripcion) {
  const ok = res.estado !== 404 && res.estado < 500;
  if (!ok) fallidas += 1;
  console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${String(res.estado).padEnd(3)} ${descripcion}`);
}

(async () => {
  console.log('\n=== Rutas que consume el frontend ===\n');

  const correo = `front+${marca}@prueba.co`;
  // Generada, no escrita: una contrasena literal en el repositorio termina
  // copiada a un entorno real.
  const password = crypto.randomBytes(18).toString('base64url');

  await pedir('POST', '/tenants', {
    cabeceras: { 'x-clave-provision': process.env.CLAVE_PROVISION },
    cuerpo: {
      nombre: 'Prueba frontend',
      slug: `front-${marca}`,
      email: correo,
      nombreAdministrador: 'Ana Torres',
      password,
    },
  });

  const login = await pedir('POST', '/auth/login', { cuerpo: { email: correo, password } });
  const sesion = login.datos.token;

  console.log('auth');
  revisar(login, 'POST /auth/login');
  revisar(await pedir('GET', '/auth/yo', { token: sesion }), 'GET /auth/yo');
  revisar(await pedir('GET', '/auth/empresas', { token: sesion }), 'GET /auth/empresas');

  const empresa = await pedir('POST', '/empresas', {
    token: sesion,
    cuerpo: {
      tipoPersona: 'JURIDICA',
      razonSocial: 'Prueba Frontend S.A.S.',
      nit: '900123456',
      dv: '8',
      sectores: ['COMERCIO'],
      grupoNiif: 'GRUPO_2',
      fechaInicioOperaciones: '2020-01-01',
    },
  });
  revisar(empresa, 'POST /empresas');

  const eleccion = await pedir('POST', '/auth/empresa', {
    token: sesion,
    cuerpo: { empresaId: empresa.datos.id },
  });
  revisar(eleccion, 'POST /auth/empresa');
  const token = eleccion.datos.token;

  console.log('\nempresa');
  revisar(await pedir('GET', '/empresas/actual', { token }), 'GET /empresas/actual');
  revisar(
    await pedir('PATCH', '/empresas/actual', { token, cuerpo: { nombreComercial: 'Prueba' } }),
    'PATCH /empresas/actual',
  );
  revisar(
    await pedir('GET', '/empresas/actual/estado-configuracion', { token }),
    'GET /empresas/actual/estado-configuracion',
  );
  revisar(await pedir('GET', '/empresas/actual/sedes', { token }), 'GET /empresas/actual/sedes');
  const sede = await pedir('POST', '/empresas/actual/sedes', {
    token,
    cuerpo: {
      codigo: '001',
      nombre: 'Principal',
      direccion: 'Cra 43A #18-95',
      municipioCodigo: '05001',
      esPrincipal: true,
    },
  });
  revisar(sede, 'POST /empresas/actual/sedes');
  revisar(
    await pedir('PATCH', `/empresas/actual/sedes/${sede.datos.id}`, {
      token,
      cuerpo: { telefono: '6044482210' },
    }),
    'PATCH /empresas/actual/sedes/:id',
  );

  console.log('\nsituacion legal');
  revisar(
    await pedir('GET', '/empresa-legal/configuracion-contable', { token }),
    'GET /empresa-legal/configuracion-contable',
  );
  revisar(
    await pedir('PUT', '/empresa-legal/configuracion-contable', {
      token,
      cuerpo: { mesCierreFiscal: 12 },
    }),
    'PUT /empresa-legal/configuracion-contable',
  );
  revisar(
    await pedir('GET', '/empresa-legal/regimenes?vigentes=false', { token }),
    'GET /empresa-legal/regimenes',
  );
  revisar(
    await pedir('POST', '/empresa-legal/regimenes', {
      token,
      cuerpo: { tipoRegimen: 'RESPONSABLE_IVA', fechaInicio: '2021-07-01' },
    }),
    'POST /empresa-legal/regimenes',
  );
  revisar(
    await pedir('GET', '/empresa-legal/representantes?vigentes=false', { token }),
    'GET /empresa-legal/representantes',
  );
  revisar(
    await pedir('POST', '/empresa-legal/representantes', {
      token,
      cuerpo: {
        nombreCompleto: 'Luisa Pena',
        tipoDocumento: 'CC',
        numeroDocumento: '43118077',
        fechaInicio: '2024-05-15',
      },
    }),
    'POST /empresa-legal/representantes',
  );
  revisar(
    await pedir('GET', '/empresa-legal/actividades?vigentes=false', { token }),
    'GET /empresa-legal/actividades',
  );
  revisar(
    await pedir('POST', '/empresa-legal/actividades', {
      token,
      cuerpo: {
        codigoCiiu: '4530',
        descripcion: 'Comercio de partes',
        esPrincipal: true,
        tarifaIcaPorMil: 4.14,
        municipioCodigo: '05001',
        fechaInicio: '2020-01-01',
      },
    }),
    'POST /empresa-legal/actividades',
  );
  revisar(
    await pedir('GET', '/empresa-legal/matriculas?vigentes=false', { token }),
    'GET /empresa-legal/matriculas',
  );

  console.log('\nresoluciones');
  revisar(await pedir('GET', '/resoluciones', { token }), 'GET /resoluciones');
  revisar(
    await pedir('POST', '/resoluciones', {
      token,
      cuerpo: {
        tipoDocumento: 'FACTURA_VENTA',
        numeroResolucion: '18764000001234',
        prefijo: 'SETP',
        rangoDesde: 1,
        rangoHasta: 5000,
        fechaResolucion: '2026-01-15',
        fechaVigenciaDesde: '2026-01-15',
        fechaVigenciaHasta: '2027-01-14',
        ambiente: 'PRODUCCION',
        reemplazarActiva: true,
      },
    }),
    'POST /resoluciones',
  );
  revisar(await pedir('GET', '/resoluciones/credenciales', { token }), 'GET /resoluciones/credenciales');
  revisar(
    await pedir('PUT', '/resoluciones/credenciales', { token, cuerpo: { softwareId: 'abc' } }),
    'PUT /resoluciones/credenciales',
  );

  console.log('\nusuarios y terceros');
  revisar(await pedir('GET', '/usuarios', { token }), 'GET /usuarios');
  revisar(
    await pedir('POST', '/usuarios', {
      token,
      cuerpo: {
        nombreCompleto: 'Sofia Rincon',
        email: `sofia+${marca}@prueba.co`,
        password: crypto.randomBytes(18).toString('base64url'),
        accesos: [{ empresaId: empresa.datos.id, rol: 'VENTAS' }],
      },
    }),
    'POST /usuarios',
  );
  revisar(await pedir('GET', '/terceros?tamano=20', { token }), 'GET /terceros');
  revisar(
    await pedir('POST', '/terceros', {
      token,
      cuerpo: {
        tipoPersona: 'NATURAL',
        tipoDocumento: 'CC',
        numeroDocumento: '71884209',
        primerNombre: 'Jose',
        primerApellido: 'Vargas',
        esCliente: true,
      },
    }),
    'POST /terceros',
  );

  console.log('\ncatalogo');
  revisar(await pedir('GET', '/municipios?q=medellin', { token }), 'GET /municipios');
  revisar(await pedir('GET', '/departamentos', { token }), 'GET /departamentos');

  console.log('\nestado final');
  const estado = await pedir('GET', '/empresas/actual/estado-configuracion', { token });
  console.log(
    `  ${estado.datos.porcentaje}% · completa=${estado.datos.completa} · siguiente=${estado.datos.siguiente}`,
  );
  console.log(
    '  ' +
      estado.datos.pasos.map((p) => `${p.nombre}:${p.estado}`).join(' · '),
  );

  console.log(`\n=== ${fallidas === 0 ? 'todas las rutas responden' : fallidas + ' rutas fallaron'} ===\n`);

  console.log('  Las cuentas creadas quedan marcadas como de prueba.');
  console.log('  Borrarlas con: node scripts/limpiar-pruebas.js --confirmar');
  process.exit(fallidas === 0 ? 0 : 1);
})();
