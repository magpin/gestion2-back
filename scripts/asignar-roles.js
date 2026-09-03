// Da contrasena a los dos roles de conexion y las deja en .env.
// Se conecta como el duenio de la base (DB_USERNAME), que es quien puede hacer ALTER ROLE.
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const clave = () => crypto.randomBytes(24).toString('base64url');

(async () => {
  const app = clave();
  const provision = clave();

  const c = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await c.connect();

  // La contrasena no se puede parametrizar en ALTER ROLE: se usa el escape de
  // literales del propio motor para no construir el SQL a mano.
  const lit = (s) => c.escapeLiteral(s);
  await c.query(`ALTER ROLE gestion_app       WITH LOGIN PASSWORD ${lit(app)}`);
  await c.query(`ALTER ROLE gestion_provision WITH LOGIN PASSWORD ${lit(provision)}`);

  const r = await c.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname IN ('gestion_app','gestion_provision') ORDER BY rolname`,
  );
  console.table(r.rows);
  await c.end();

  let env = fs.readFileSync('.env', 'utf8');
  const fijar = (k, v) => {
    env = new RegExp(`^${k}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
      : env.trimEnd() + `\n${k}=${v}\n`;
  };
  fijar('DB_APP_USERNAME', 'gestion_app');
  fijar('DB_APP_PASSWORD', app);
  fijar('DB_PROVISION_USERNAME', 'gestion_provision');
  fijar('DB_PROVISION_PASSWORD', provision);
  fijar('CLAVE_PROVISION', clave());
  fs.writeFileSync('.env', env);
  console.log('.env actualizado (las contrasenas no se imprimen)');
})();
