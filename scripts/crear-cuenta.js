// Alta de una cuenta nueva. Es lo que hace el super admin al vender el sistema.
//
// Crea la cuenta y su primer usuario. Ese usuario entra, crea su empresa y queda
// como su director.
//
// Nada va escrito en el archivo: todo entra por argumentos y la contraseña se
// genera. Una contraseña literal en el repositorio termina copiada a producción.
//
// Uso:
//   node scripts/crear-cuenta.js \
//     --nombre "Contadores Asociados" \
//     --slug contadores-asociados \
//     --email director@cliente.co \
//     --admin "Ana Torres" \
//     [--plan CONTADOR] [--max-empresas 15] [--max-usuarios 10]
//
// De la empresa no se pregunta nada: la crea el director cuando entra. Quien
// vende no conoce su NIT ni su marco NIIF.
require('dotenv').config();
const crypto = require('crypto');

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

(async () => {
  const a = argumentos();

  const faltan = ['nombre', 'slug', 'email', 'admin'].filter((k) => !a[k]);
  if (faltan.length > 0) {
    console.error(`Faltan argumentos: ${faltan.map((f) => '--' + f).join(', ')}`);
    console.error('Ver el encabezado de este archivo para el uso completo.');
    process.exit(1);
  }

  if (!process.env.CLAVE_PROVISION) {
    console.error('Falta CLAVE_PROVISION en el entorno.');
    process.exit(1);
  }

  // 24 bytes en base64url: suficiente entropia para que no haga falta rotarla el
  // primer dia, y escribible a mano si toca dictarla por telefono.
  const password = crypto.randomBytes(18).toString('base64url');

  const cuerpo = {
    nombre: a.nombre,
    slug: a.slug,
    plan: a.plan || 'BASICO',
    maxEmpresas: Number(a['max-empresas'] || 1),
    maxUsuarios: Number(a['max-usuarios'] || 3),
    email: a.email,
    nombreAdministrador: a.admin,
    password,
  };

  const res = await fetch(`${BASE}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clave-provision': process.env.CLAVE_PROVISION,
    },
    body: JSON.stringify(cuerpo),
  });

  const datos = await res.json();

  if (res.status !== 201) {
    console.error(`Fallo (${res.status}):`, JSON.stringify(datos, null, 2));
    process.exit(1);
  }

  console.log('\n  Cuenta creada\n');
  console.log(`  Cuenta       ${a.nombre}`);
  console.log('\n  Credenciales de acceso — se muestran una sola vez:\n');
  console.log(`    Correo      ${a.email}`);
  console.log(`    Contrasena  ${password}`);
  console.log('\n  Entrar en http://localhost:3000/login\n');
})();
