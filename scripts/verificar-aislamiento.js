// Comprueba que RLS aisla de verdad, conectado como gestion_app.
//
// No basta con que las politicas existan: si la API se conecta con un rol que
// las ignora, el aislamiento es decorativo. Este script prueba el caso real.
require('dotenv').config();
const { Client } = require('pg');

const conectar = (usuario, password) =>
  new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: usuario,
    password,
    database: process.env.DB_NAME,
  });

const ok = (b) => (b ? 'OK  ' : 'FALLA');

(async () => {
  const provision = conectar(process.env.DB_PROVISION_USERNAME, process.env.DB_PROVISION_PASSWORD);
  const app = conectar(process.env.DB_APP_USERNAME, process.env.DB_APP_PASSWORD);
  // Ni gestion_app ni gestion_provision tienen DELETE: en este sistema nada se
  // borra. La limpieza de los datos de prueba la hace el duenio de la base.
  const duenio = conectar(process.env.DB_USERNAME, process.env.DB_PASSWORD);
  await provision.connect();
  await app.connect();
  await duenio.connect();

  let tenantA, tenantB;
  try {
    // Dos cuentas distintas, creadas por la conexion de aprovisionamiento.
    const marca = Date.now();
    const a = await provision.query(
      `INSERT INTO tenant (nombre, slug) VALUES ('Prueba A', $1) RETURNING id`,
      [`prueba-a-${marca}`],
    );
    const b = await provision.query(
      `INSERT INTO tenant (nombre, slug) VALUES ('Prueba B', $1) RETURNING id`,
      [`prueba-b-${marca}`],
    );
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;

    for (const [t, nit, dv] of [[tenantA, '900123456', '8'], [tenantB, '901884220', '5']]) {
      await provision.query(
        `INSERT INTO empresa (tenant_id, tipo_persona, razon_social, nit, dv, sector_economico)
         VALUES ($1, 'JURIDICA', 'Empresa de prueba', $2, $3, 'COMERCIO')`,
        [t, nit, dv],
      );
    }

    const rol = await app.query('SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    console.log(`conectado como ${rol.rows[0].u} · superusuario=${rol.rows[0].rolsuper} · bypassrls=${rol.rows[0].rolbypassrls}`);

    // 1 · Sin contexto de sesion no se ve nada.
    const sinCtx = await app.query('SELECT count(*)::int n FROM empresa');
    console.log(`${ok(sinCtx.rows[0].n === 0)}  sin contexto la tabla empresa devuelve 0 filas (devolvio ${sinCtx.rows[0].n})`);

    // 2 · Con el contexto del tenant A solo se ve la empresa de A.
    await app.query('BEGIN');
    await app.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantA]);
    const conCtx = await app.query('SELECT nit FROM empresa');
    console.log(`${ok(conCtx.rowCount === 1 && conCtx.rows[0].nit === '900123456')}  con el tenant A se ve 1 empresa y es la suya (vio ${conCtx.rowCount})`);

    // 3 · Un SELECT que se olvide del filtro no alcanza al vecino.
    const fuga = await app.query('SELECT count(*)::int n FROM empresa WHERE tenant_id <> $1', [tenantA]);
    console.log(`${ok(fuga.rows[0].n === 0)}  un SELECT sin filtro no alcanza al otro tenant (vio ${fuga.rows[0].n})`);

    // 4 · Escribir en otro tenant lo rechaza la politica, no el codigo.
    let bloqueado = false;
    try {
      await app.query(
        `INSERT INTO empresa (tenant_id, tipo_persona, razon_social, nit, dv, sector_economico)
         VALUES ($1, 'JURIDICA', 'Intruso', '830045912', '7', 'COMERCIO')`,
        [tenantB],
      );
    } catch (e) {
      bloqueado = e.code === '42501';
    }
    console.log(`${ok(bloqueado)}  insertar en otro tenant lo rechaza RLS`);
    await app.query('ROLLBACK');

    // 5 · Nada se borra: gestion_app no tiene DELETE.
    let sinDelete = false;
    try {
      await app.query('BEGIN');
      await app.query('SELECT set_config($1,$2,true)', ['app.tenant_id', tenantA]);
      await app.query('DELETE FROM empresa');
    } catch (e) {
      sinDelete = e.code === '42501';
    } finally {
      await app.query('ROLLBACK');
    }
    console.log(`${ok(sinDelete)}  DELETE sobre empresa esta denegado por privilegios`);
  } finally {
    // La prueba no deja rastro: se borra con la conexion de aprovisionamiento,
    // que es la unica que puede, y solo lo que esta prueba creo.
    if (tenantA) {
      await duenio.query('DELETE FROM empresa WHERE tenant_id = ANY($1)', [[tenantA, tenantB]]);
      await duenio.query('DELETE FROM tenant WHERE id = ANY($1)', [[tenantA, tenantB]]);
    }
    await app.end();
    await provision.end();
    await duenio.end();
  }
})();
