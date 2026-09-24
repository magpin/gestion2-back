// Deja los dos roles de conexión listos para entrar, con la contraseña del
// entorno. Es la versión de servidor de `asignar-roles.js`.
//
// `asignar-roles.js` inventa las contraseñas y las escribe en `.env`: sirve en
// la máquina de cada uno. En el servidor las contraseñas ya existen —viven en
// el `.env` de `/opt/contable/<entorno>`— y la imagen no tiene `.env` que
// escribir. Por eso este script no inventa nada: toma DB_APP_PASSWORD y
// DB_PROVISION_PASSWORD y se las pone a los roles que crearon las migraciones.
//
// Se puede correr las veces que sea: el servicio `migrar` del compose de
// producción lo corre después de cada `migration:run`. Si alguien cambia una
// contraseña en `.env`, el próximo despliegue la aplica.
//
// Se conecta como el dueño de la base (DB_USERNAME), que es quien puede hacer
// ALTER ROLE.
require('dotenv').config();
const { Client } = require('pg');

const ROLES = [
  { rol: 'gestion_app', usuario: 'DB_APP_USERNAME', clave: 'DB_APP_PASSWORD' },
  {
    rol: 'gestion_provision',
    usuario: 'DB_PROVISION_USERNAME',
    clave: 'DB_PROVISION_PASSWORD',
  },
];

function falla(mensaje) {
  console.error(`preparar-roles: ${mensaje}`);
  process.exit(1);
}

(async () => {
  for (const { rol, usuario, clave } of ROLES) {
    // El nombre del rol lo fijan las migraciones: si el entorno dice otro, la
    // API intentaría entrar con un rol que no existe y fallaría más tarde y
    // más confuso. Mejor que falle acá.
    if (process.env[usuario] !== rol) {
      falla(`${usuario} tiene que ser "${rol}" (es "${process.env[usuario] ?? ''}")`);
    }
    if ((process.env[clave] ?? '').length < 16) {
      falla(`${clave} falta o tiene menos de 16 caracteres`);
    }
  }

  const c = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await c.connect();

  try {
    // La contraseña no se puede parametrizar en ALTER ROLE: se usa el escape de
    // literales del propio motor para no construir el SQL a mano.
    for (const { rol, clave } of ROLES) {
      await c.query(
        `ALTER ROLE ${rol} WITH LOGIN PASSWORD ${c.escapeLiteral(process.env[clave])}`,
      );
    }

    const r = await c.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname IN ('gestion_app','gestion_provision') ORDER BY rolname`,
    );
    console.table(r.rows);

    // La API se conecta como gestion_app. Si ese rol fuera superusuario o se
    // saltara RLS, el aislamiento entre empresas no existiría.
    const app = r.rows.find((f) => f.rolname === 'gestion_app');
    if (!app || app.rolsuper || app.rolbypassrls) {
      falla('gestion_app no puede ser superusuario ni tener BYPASSRLS');
    }
    console.log('preparar-roles: listo (las contraseñas no se imprimen)');
  } finally {
    await c.end();
  }
})().catch((e) => falla(e.message));
