// Borra las cuentas que dejan los scripts de prueba.
//
// Los scripts crean tenants de usar y tirar con un sello de tiempo en el slug.
// Sin esta limpieza se acumulan, y el listado de administración termina lleno de
// "Contadores Asociados" repetidos que parecen datos de mentira dentro del
// producto.
//
// Borra de verdad —no anula— porque son datos que nunca existieron para nadie.
// Por eso corre con el dueño de la base: ni `gestion_app` ni `gestion_provision`
// tienen privilegio DELETE, justamente para que esto no pueda pasar desde la API.
//
// Uso:
//   node scripts/limpiar-pruebas.js              muestra qué borraría
//   node scripts/limpiar-pruebas.js --confirmar  lo borra
require('dotenv').config();
const { Client } = require('pg');

// Los slugs que generan los scripts. Una cuenta real no lleva sello de tiempo.
const PATRONES = [
  'prueba-a-%',
  'prueba-b-%',
  'contadores-%',
  'otra-%',
  'demo-%',
  'front-%',
  'cliente-%',
  'repuestos-valle-%',
  // El slug ahora sale del correo, y los correos de prueba llevan sello de tiempo.
  'director1%',
  'front1%',
  'sofia1%',
];

// Lo que cuelga del tenant y no de una empresa. Lo que cuelga de una empresa
// no se lista: se descubre en la base por la columna `empresa_id`, así cada
// módulo nuevo —contabilidad, inventario, ventas, tesorería— queda cubierto sin
// tocar este archivo. El orden lo resuelven las FK: se intenta cada tabla y la
// que todavía tiene hijos vivos se reintenta en la vuelta siguiente.
const TABLAS_TENANT = [
  ['plataforma_bitacora', 'tenant_id = ANY($1)'],
  ['usuario_acceso_dia', 'tenant_id = ANY($1)'],
  ['usuario_empresa_rol', 'tenant_id = ANY($1)'],
  ['usuario_rol_tenant', 'tenant_id = ANY($1)'],
  ['empresa', 'tenant_id = ANY($1)'],
  ['usuario', 'tenant_id = ANY($1)'],
  ['tenant', 'id = ANY($1)'],
];

/** Borra en vueltas hasta que ninguna tabla quede bloqueada por una FK. */
async function borrarPorEmpresa(c, ids) {
  const { rows } = await c.query(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'empresa_id'`,
  );
  let pendientes = rows.map((r) => r.table_name);
  for (let vuelta = 0; pendientes.length > 0 && vuelta < 30; vuelta += 1) {
    const siguen = [];
    for (const tabla of pendientes) {
      await c.query('SAVEPOINT tabla');
      try {
        const r = await c.query(
          `DELETE FROM "${tabla}" WHERE empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))`,
          [ids],
        );
        if (r.rowCount > 0) console.log(`    ${String(r.rowCount).padStart(5)}  ${tabla}`);
        await c.query('RELEASE SAVEPOINT tabla');
      } catch (e) {
        if (e.code !== '23503') throw e; // solo una FK justifica reintentar
        await c.query('ROLLBACK TO SAVEPOINT tabla');
        siguen.push(tabla);
      }
    }
    if (siguen.length === pendientes.length) {
      throw new Error(`Quedan tablas que no se pueden vaciar: ${siguen.join(', ')}`);
    }
    pendientes = siguen;
  }
}

(async () => {
  const confirmar = process.argv.includes('--confirmar');

  const c = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await c.connect();

  const condicion = PATRONES.map((_, i) => `slug LIKE $${i + 1}`).join(' OR ');
  const { rows } = await c.query(
    `SELECT id, slug, nombre FROM tenant WHERE ${condicion} ORDER BY creado_en`,
    PATRONES,
  );

  if (rows.length === 0) {
    console.log('\n  No hay cuentas de prueba.\n');
    await c.end();
    return;
  }

  console.log(`\n  ${rows.length} cuenta(s) de prueba:\n`);
  rows.forEach((r) => console.log(`    ${r.slug.padEnd(34)} ${r.nombre}`));

  if (!confirmar) {
    console.log('\n  Nada borrado. Repetir con --confirmar.\n');
    await c.end();
    return;
  }

  const ids = rows.map((r) => r.id);

  try {
    await c.query('BEGIN');
    await borrarPorEmpresa(c, ids);
    for (const [tabla, donde] of TABLAS_TENANT) {
      const r = await c.query(`DELETE FROM ${tabla} WHERE ${donde}`, [ids]);
      if (r.rowCount > 0) console.log(`    ${String(r.rowCount).padStart(5)}  ${tabla}`);
    }
    await c.query('COMMIT');
    console.log(`\n  ${rows.length} cuenta(s) borradas.\n`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\n  Fallo, no se borró nada:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
