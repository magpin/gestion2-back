// Genera el DDL con el catalogo DANE a partir de DIVIPOLA (datos.gov.co).
//
// Se ejecuta a mano cuando el DANE publique una actualizacion; el resultado
// —db/migrations/0010_geografia_datos.sql— es lo que se versiona, no este script.
const fs = require('fs');
const path = require('path');

const FUENTE = 'https://www.datos.gov.co/resource/gdxc-w37w.json?%24limit=2000';
const SALIDA = path.join(__dirname, '..', 'db', 'migrations', '0010_geografia_datos.sql');

// Los nombres llegan en mayuscula sostenida. Se pasan a capitalizacion normal
// dejando en minuscula las particulas, que es como los escribe el propio DANE
// en sus publicaciones: "San Andres de Cuerquia", "Villa de Leyva".
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'el', 'en']);

function capitalizar(texto) {
  return texto
    .toLocaleLowerCase('es')
    .split(/\s+/)
    .map((palabra, i) => {
      if (i > 0 && PARTICULAS.has(palabra)) return palabra;
      // Respeta guiones y puntos: "d.c." → "D.C.", "santa-rosa" → "Santa-Rosa".
      return palabra.replace(/(^|[-])([\p{L}])/gu, (_, sep, letra) => sep + letra.toLocaleUpperCase('es'));
    })
    .join(' ')
    .replace(/\bD\.c\./gi, 'D.C.');
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`;

(async () => {
  const filas = await (await fetch(FUENTE)).json();
  console.log(`DIVIPOLA: ${filas.length} filas`);

  const departamentos = new Map();
  const municipios = [];

  for (const f of filas) {
    if (!f.cod_dpto || !f.cod_mpio || !f.nom_mpio) continue;
    departamentos.set(f.cod_dpto, capitalizar(f.dpto));
    municipios.push([f.cod_mpio, f.cod_dpto, capitalizar(f.nom_mpio)]);
  }

  municipios.sort((a, b) => a[0].localeCompare(b[0]));
  const deps = [...departamentos.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const sql = `-- =============================================================================
-- 0010_geografia_datos — catalogo DANE (DIVIPOLA, corte 30 de diciembre de 2024)
-- =============================================================================
-- ${deps.length} departamentos y ${municipios.length} municipios.
--
-- Es dato, no esquema, pero viaja como migracion a proposito: 'empresa_sede' y
-- 'tercero' tienen FK contra 'municipio', asi que una base recien creada sin
-- estas filas no puede guardar ni una sede. Cargarlo aparte convierte en opcional
-- algo que no lo es.
--
-- Se regenera con: node scripts/generar-seed-geografia.js
-- Fuente: https://www.datos.gov.co/resource/gdxc-w37w
--
-- ON CONFLICT DO NOTHING: reaplicarlo tras una actualizacion del DANE agrega los
-- municipios nuevos sin tocar los existentes. Un municipio no se borra —puede
-- estar referenciado por una sede o un tercero de hace anios.

INSERT INTO departamento (codigo, nombre) VALUES
${deps.map(([c, n]) => `  (${lit(c)}, ${lit(n)})`).join(',\n')}
ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre;

INSERT INTO municipio (codigo, departamento_codigo, nombre) VALUES
${municipios.map(([c, d, n]) => `  (${lit(c)}, ${lit(d)}, ${lit(n)})`).join(',\n')}
ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre,
                                   departamento_codigo = EXCLUDED.departamento_codigo;
`;

  fs.writeFileSync(SALIDA, sql, 'utf8');
  console.log(`escrito ${SALIDA}`);
  console.log(`${deps.length} departamentos · ${municipios.length} municipios`);
  console.log('muestra:', deps.slice(0, 3).map(([c, n]) => `${c} ${n}`).join(' | '));
  console.log('muestra:', municipios.slice(0, 3).map(([c, , n]) => `${c} ${n}`).join(' | '));
})();
