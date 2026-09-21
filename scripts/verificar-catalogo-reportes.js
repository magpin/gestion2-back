// ¿El catálogo de reportes dice la verdad?
//
// `catalogo.spec.ts` vigila las reglas —que no haya claves repetidas, que una
// lista traiga sus valores, que no se agrupe por un monto— pero no puede saber
// si `v.total_iva` existe: para eso hace falta una base viva, y por eso esto es
// un script y no una prueba de la suite.
//
// Arma un SELECT por origen con **todas** sus columnas, le pone `LIMIT 0` y se
// lo manda a Postgres. No trae filas: solo pregunta si la consulta es válida.
// Es lo que separa un catálogo escrito de memoria de uno que corre.
//
// Uso:
//   node scripts/verificar-catalogo-reportes.js
require('dotenv').config();
const { Client } = require('pg');

/**
 * El catálogo es TypeScript. Se registra `ts-node` en este mismo proceso y se
 * lo pide como cualquier módulo: **se lee el archivo de verdad**, no una copia.
 * Un script que repitiera las columnas acá podría quedar verde mientras el
 * catálogo se rompe, que es exactamente lo que esto viene a evitar.
 */
function leerCatalogo() {
  // `transpileOnly` sin `compilerOptions`: el `tsconfig` del proyecto está
  // afinado para compilar la aplicación —`NodeNext`, `resolvePackageJsonExports`
  // y compañía— y cada opción que se pisa acá arrastra a la siguiente. Como lo
  // único que hace falta es leer un objeto constante, alcanza con transpilar.
  require('ts-node').register({ transpileOnly: true });
  return require('../src/modules/reportes/reglas/catalogo').ORIGENES;
}

(async () => {
  const origenes = leerCatalogo();
  const c = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await c.connect();

  console.log('\n=== Catálogo de reportes contra la base ===\n');
  let fallidos = 0;

  for (const origen of Object.values(origenes)) {
    const seleccion = origen.columnas
      .map((col, i) => `${col.sql} AS c${i}`)
      .join(',\n         ');

    // El rango de fechas va adentro a propósito: es obligatorio en todo reporte
    // y si la columna de fecha no existiera, sin esto no se notaría.
    const sql = `SELECT ${seleccion}
        FROM ${origen.desde}
       WHERE ${origen.fecha} BETWEEN $1::date AND $2::date
       LIMIT 0`;

    try {
      await c.query(sql, ['2020-01-01', '2020-01-02']);
      console.log(
        `  OK    ${origen.clave.padEnd(14)} ${String(origen.columnas.length).padStart(2)} columnas`,
      );
    } catch (error) {
      fallidos += 1;
      console.log(`  FALLA ${origen.clave.padEnd(14)} ${error.message}`);
      // Cuál columna es: se reintenta una por una, que es lento pero solo pasa
      // cuando ya algo está mal.
      for (const col of origen.columnas) {
        try {
          await c.query(
            `SELECT ${col.sql} FROM ${origen.desde} WHERE ${origen.fecha} = $1::date LIMIT 0`,
            ['2020-01-01'],
          );
        } catch (e) {
          console.log(`          └─ ${col.clave}: ${e.message}`);
        }
      }
    }
  }

  await c.end();
  console.log(
    fallidos === 0
      ? '\nLos seis orígenes corren.\n'
      : `\n${fallidos} origen(es) con problemas.\n`,
  );
  process.exit(fallidos === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
