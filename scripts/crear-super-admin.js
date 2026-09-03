// Da de alta un administrador de la plataforma.
//
// Es un acto de instalación, no una función del producto: se corre desde la
// máquina donde vive el servidor, con la conexión de aprovisionamiento. No hay
// pantalla para esto a propósito —una pantalla pública para crear super admins
// es exactamente la puerta que no debe existir—.
//
// Uso:
//   node scripts/crear-super-admin.js --email tu@correo.co --nombre "Tu Nombre"
//   node scripts/crear-super-admin.js --email tu@correo.co --reset
//
// La contraseña se genera y se muestra una sola vez. Nada queda escrito acá.
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const { hash } = require('@node-rs/argon2');

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

  if (!a.email) {
    console.error('Falta --email');
    console.error('  node scripts/crear-super-admin.js --email tu@correo.co --nombre "Tu Nombre"');
    process.exit(1);
  }
  if (!a.nombre && !a.reset) {
    console.error('Falta --nombre (o --reset para cambiarle la contrasena a uno existente)');
    process.exit(1);
  }

  const usuario = process.env.DB_PROVISION_USERNAME || process.env.DB_USERNAME;
  const password = process.env.DB_PROVISION_PASSWORD || process.env.DB_PASSWORD;

  const c = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: usuario,
    password,
    database: process.env.DB_NAME,
  });
  await c.connect();

  // 18 bytes en base64url: entropia de sobra y todavia se puede dictar por telefono.
  const clave = crypto.randomBytes(18).toString('base64url');
  const hashed = await hash(clave);

  try {
    if (a.reset) {
      const r = await c.query(
        `UPDATE plataforma_admin SET hash_password = $2, activo = true
          WHERE email = $1 RETURNING id, nombre_completo`,
        [a.email, hashed],
      );
      if (r.rowCount === 0) {
        console.error(`No existe ningun administrador con el correo ${a.email}`);
        process.exit(1);
      }
      console.log(`\n  Contrasena restablecida para ${r.rows[0].nombre_completo}\n`);
    } else {
      await c.query(
        `INSERT INTO plataforma_admin (email, nombre_completo, hash_password)
         VALUES ($1, $2, $3)`,
        [a.email, a.nombre, hashed],
      );
      console.log('\n  Administrador de plataforma creado\n');
    }

    console.log('  Credenciales — se muestran una sola vez:\n');
    console.log(`    Correo      ${a.email}`);
    console.log(`    Contrasena  ${clave}`);
    console.log('\n  Entrar en http://localhost:3000/login — el login es uno solo\n');
  } catch (e) {
    if (e.code === '23505') {
      console.error(`Ya existe un administrador con el correo ${a.email}. Usa --reset.`);
    } else {
      console.error('Fallo:', e.message);
    }
    process.exit(1);
  } finally {
    await c.end();
  }
})();
