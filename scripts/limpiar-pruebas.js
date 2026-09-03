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

// De la hoja a la raíz: cada tabla antes de aquella a la que apunta.
const TABLAS = [
  ['plataforma_bitacora', 'tenant_id = ANY($1)'],
  ['tercero_responsabilidad_fiscal', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['tercero', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_credencial_dian', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_resolucion_dian', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_configuracion_contable', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_matricula_mercantil', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_representante', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_regimen_tributario', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_actividad_economica', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['empresa_sede', 'empresa_id IN (SELECT id FROM empresa WHERE tenant_id = ANY($1))'],
  ['usuario_empresa_rol', 'tenant_id = ANY($1)'],
  ['usuario_rol_tenant', 'tenant_id = ANY($1)'],
  ['empresa', 'tenant_id = ANY($1)'],
  ['usuario', 'tenant_id = ANY($1)'],
  ['tenant', 'id = ANY($1)'],
];

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
    for (const [tabla, donde] of TABLAS) {
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
