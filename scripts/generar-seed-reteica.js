#!/usr/bin/env node
// Genera db/migrations/0093_reteica_municipios.sql a partir de las tablas de
// tarifas de ICA de db/datos/reteica/ (plan motor de retenciones, Fase 8,
// carga de ReteICA).
//
// Uso (desde backend/):  node scripts/generar-seed-reteica.js
//
// Cada tabla viene como «código;CIIU;tipo;tarifa_por_mil;descripción», con
// una o varias actividades en la columna CIIU: códigos sueltos, listas
// separadas por comas y rangos («1081-1084», «5111A-5122A»). La letra es una
// subdivisión municipal del CIIU (Pereira).
//
// Reglas:
// - Una fila por actividad. El código de actividad es el del municipio cuando
//   ya es único (Bogotá, Cali); si no, «grupo-actividad» (Bucaramanga, Pereira),
//   más una fila por grupo cuando todo el grupo tiene la misma tarifa: así el
//   proveedor puede informar su código de grupo.
// - Las no gravadas (tarifa 0) no se cargan: no hay retención que calcular.
// - Un CIIU con varias tarifas en el mismo municipio: el motor busca primero
//   por el código de actividad que informe el proveedor; si no lo informa, por
//   CIIU, y el CIIU queda solo en la fila de tarifa más alta —la regla de los
//   estatutos cuando no se puede establecer la actividad—.
const fs = require('node:fs');
const path = require('node:path');

const VALIDADO_POR =
  'Claude, con el estatuto del municipio (pendiente de ratificar Yeris)';
const VALIDADO_EN = '2026-09-26';

/** Lo que se sabe de cada municipio, con su fuente. */
const MUNICIPIOS = [
  {
    archivo: 'bogota-11001.txt',
    codigo: '11001',
    anio: 2026,
    baseCompras: 27,
    baseServicios: 4,
    periodicidad: 'BIMESTRAL',
    acumula: false,
    acuerdo:
      'Bogotá: Acuerdo 65 de 2002 arts. 7-14 (mod. Acuerdo 780 de 2020); Decreto 639 de 2025 arts. 11, 16 y 17; Res. SDH 265 de 2021 (tarifas) y 195 de 2025 (periodicidad)',
    // Art. 9 lit. d) del Acuerdo 65: no se retiene a un gran contribuyente DIAN
    // que declare ICA en Bogotá, salvo que el agente sea entidad pública.
    matriz: [
      ['ORDINARIO', 'GRAN_CONTRIBUYENTE_DIAN', false, 'Acuerdo 65 de 2002, art. 9 lit. d)'],
      ['GRAN_CONTRIBUYENTE_DIAN', 'GRAN_CONTRIBUYENTE_DIAN', false, 'Acuerdo 65 de 2002, art. 9 lit. d)'],
    ],
  },
  {
    // El Acuerdo 643 de 2026 es de este año: sus tarifas rigen desde el año
    // gravable siguiente (art. 338 de la Constitución). Para 2026 no hay tabla
    // confirmada, así que se carga 2027.
    archivo: 'cali-76001.txt',
    codigo: '76001',
    anio: 2027,
    baseCompras: 15,
    baseServicios: 3,
    periodicidad: 'BIMESTRAL',
    acumula: false,
    acuerdo: 'Cali: Acuerdo 643 de 2026, arts. 96 y 113-120',
    // Art. 120 lit. f): no se retiene al gran contribuyente (DIAN o de Cali).
    matriz: [
      ['ORDINARIO', 'GRAN_CONTRIBUYENTE_DIAN', false, 'Acuerdo 643 de 2026, art. 120 lit. f)'],
      ['GRAN_CONTRIBUYENTE_DIAN', 'GRAN_CONTRIBUYENTE_DIAN', false, 'Acuerdo 643 de 2026, art. 120 lit. f)'],
    ],
  },
  {
    archivo: 'bucaramanga-68001.txt',
    codigo: '68001',
    anio: 2026,
    baseCompras: 25,
    baseServicios: 10,
    periodicidad: 'MENSUAL',
    acumula: false,
    acuerdo:
      'Bucaramanga: Acuerdo 033 de 2020 arts. 44-50 (mod. Acuerdo 031 de 2021); Res. 4-R-202512-00030768 y 4-R-202512-00030019 de 2025',
    matriz: [],
  },
  {
    archivo: 'pereira-66001.txt',
    codigo: '66001',
    anio: 2026,
    baseCompras: 10,
    baseServicios: 2,
    periodicidad: 'BIMESTRAL',
    acumula: false,
    acuerdo:
      'Pereira: Acuerdo 029 de 2015 (mod. Acuerdo 036 de 2025); Decreto 204 de 2023 (tarifas); Decreto 000005 de 2026 (bases)',
    matriz: [],
  },
];

const TIPO = {
  industrial: 'INDUSTRIAL',
  comercial: 'COMERCIAL',
  servicios: 'SERVICIOS',
  financiera: 'FINANCIERA',
};

const sql = (v) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/** «1081-1084» → 1081…1084; «5111A-5122A» → 5111A…5122A; «4721A» → 4721A. */
function expandir(item) {
  const limpio = item.trim();
  const rango = limpio.match(/^(\d+)([A-Z]?)-(\d+)([A-Z]?)$/);
  if (rango === null) return /^\d+[A-Z]?$/.test(limpio) ? [limpio] : [];
  const [, a, letra, b] = rango;
  if (a.length !== b.length) return [limpio.split('-')[0]];
  const salida = [];
  for (let n = Number(a); n <= Number(b); n++) {
    salida.push(String(n).padStart(a.length, '0') + letra);
  }
  return salida;
}

function filasDe(m) {
  const texto = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'datos', 'reteica', m.archivo),
    'utf8',
  );
  const renglones = texto
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('código;'))
    .map((l) => {
      const [grupo, ciius, tipoTexto, tarifa, ...desc] = l.split(';');
      return {
        grupo: grupo.trim(),
        actividades: ciius.split(',').flatMap(expandir),
        tipo: TIPO[tipoTexto.trim().split(' ')[0].toLowerCase()],
        tarifa: Number(tarifa.replace(',', '.')),
        descripcion: desc.join(';').trim(),
      };
    })
    .filter((r) => r.tarifa > 0 && r.tipo !== undefined && r.actividades.length > 0);

  const veces = new Map();
  for (const r of renglones) veces.set(r.grupo, (veces.get(r.grupo) ?? 0) + 1);

  const filas = [];
  const usados = new Set();
  const agregar = (f) => {
    if (usados.has(f.codigo)) return;
    usados.add(f.codigo);
    filas.push(f);
  };
  for (const r of renglones) {
    const codigoPropio = veces.get(r.grupo) === 1 && r.actividades.length === 1;
    for (const a of r.actividades) {
      agregar({
        codigo: codigoPropio ? r.grupo : `${r.grupo}-${a}`,
        ciiu: a.replace(/[A-Z]$/, '').slice(0, 4).padStart(4, '0'),
        tipo: r.tipo,
        tarifa: r.tarifa,
        descripcion: r.descripcion,
      });
    }
  }
  // El código de grupo, cuando todo el grupo va a la misma tarifa.
  const porGrupo = new Map();
  for (const r of renglones) {
    const g = porGrupo.get(r.grupo) ?? [];
    g.push(r);
    porGrupo.set(r.grupo, g);
  }
  for (const [grupo, rs] of porGrupo) {
    if (rs.length === 1 && rs[0].actividades.length === 1) continue;
    if (new Set(rs.map((r) => `${r.tipo}|${r.tarifa}`)).size !== 1) continue;
    agregar({
      codigo: grupo,
      ciiu: null,
      tipo: rs[0].tipo,
      tarifa: rs[0].tarifa,
      descripcion: `Grupo ${grupo}: ${rs.map((r) => r.descripcion).join(' · ')}`.slice(0, 500),
    });
  }
  // Un CIIU con varias tarifas: solo la más alta lo conserva.
  const porCiiu = new Map();
  for (const f of filas) {
    if (f.ciiu === null) continue;
    const g = porCiiu.get(f.ciiu) ?? [];
    g.push(f);
    porCiiu.set(f.ciiu, g);
  }
  for (const g of porCiiu.values()) {
    if (new Set(g.map((f) => f.tarifa)).size < 2) {
      g.slice(1).forEach((f) => (f.ciiu = null));
      continue;
    }
    const mayor = g.reduce((a, b) => (b.tarifa > a.tarifa ? b : a));
    for (const f of g) if (f !== mayor) f.ciiu = null;
  }
  return filas;
}

const partes = [];
partes.push(`-- =============================================================================
-- 0093 — ReteICA de Bogotá, Cali, Bucaramanga y Pereira
-- =============================================================================
--
-- GENERADO por scripts/generar-seed-reteica.js a partir de db/datos/reteica/.
-- No se edita a mano: se cambia la tabla o el script y se vuelve a generar.
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (carga de ReteICA).
-- Investigado el 26-09-2026 en las fuentes oficiales de cada municipio; firmado
-- «Claude … (pendiente de ratificar Yeris)».
--
-- Pendientes que quedan escritos:
-- * Bucaramanga: el Acuerdo 033 de 2020 dice que se retiene también sobre
--   avisos y tableros (15 %) y la sobretasa bomberil (10 %). No se confirmó que
--   sumen a la tarifa de retención: se carga solo la tarifa de ICA.
-- * Pereira: casi todo proveedor del régimen ordinario es autorretenedor (art.
--   52, Ac. 036 de 2025); solo se retiene si su factura no lo dice. Se marca en
--   el perfil de ICA del proveedor.
-- * Cali: tarifas del Acuerdo 643 de 2026, cargadas para 2027.
-- * Barranquilla, Cartagena y Apartadó: sin base mínima confirmada; no se cargan.

-- Bogotá (régimen especial, Decreto Ley 1421 de 1993) y Cali tienen tarifas
-- legales por encima del rango de la Ley 14 de 1983 (2–7 ‰ industria, 2–10 ‰
-- comercio y servicios): 11,04 ‰, 13,8 ‰. El control pasa a un techo que atrapa
-- errores de digitación sin rechazar tarifas legales.
ALTER TABLE ica_tarifa DROP CONSTRAINT ck_ica_tarifa_rango;
ALTER TABLE ica_tarifa ADD CONSTRAINT ck_ica_tarifa_rango
  CHECK (tarifa_por_mil > 0 AND tarifa_por_mil <= 30);
`);

let total = 0;
for (const m of MUNICIPIOS) {
  const filas = filasDe(m);
  total += filas.length;
  partes.push(`
-- -----------------------------------------------------------------------------
-- ${m.acuerdo.split(':')[0]} (${m.codigo}) — ${m.anio}: ${filas.length} actividades
-- -----------------------------------------------------------------------------
INSERT INTO ica_parametro
  (municipio_codigo, anio, base_minima_uvt_compras, base_minima_uvt_servicios,
   tarifa_general_por_mil, usa_tarifa_por_actividad, acumula_en_periodo,
   periodicidad, acuerdo, validado_por, validado_en)
VALUES (${sql(m.codigo)}, ${m.anio}, ${m.baseCompras}, ${m.baseServicios}, NULL, true, ${m.acumula},
        ${sql(m.periodicidad)}, ${sql(m.acuerdo)}, ${sql(VALIDADO_POR)}, ${sql(VALIDADO_EN)})
ON CONFLICT (municipio_codigo, anio) DO NOTHING;
`);
  for (const [pagador, beneficiario, retiene, fundamento] of m.matriz) {
    partes.push(`INSERT INTO ica_matriz_agente (municipio_codigo, anio, perfil_pagador, perfil_beneficiario, retiene, fundamento)
VALUES (${sql(m.codigo)}, ${m.anio}, ${sql(pagador)}, ${sql(beneficiario)}, ${retiene}, ${sql(fundamento)})
ON CONFLICT (municipio_codigo, anio, perfil_pagador, perfil_beneficiario) DO NOTHING;
`);
  }
  for (let i = 0; i < filas.length; i += 200) {
    const lote = filas.slice(i, i + 200);
    partes.push(`INSERT INTO ica_tarifa
  (municipio_codigo, anio, codigo_actividad, ciiu, descripcion, tipo, tarifa_por_mil, acuerdo, validado_por, validado_en)
VALUES
${lote
  .map(
    (f) =>
      `  (${sql(m.codigo)}, ${m.anio}, ${sql(f.codigo)}, ${sql(f.ciiu)}, ${sql(f.descripcion)}, ${sql(f.tipo)}, ${f.tarifa}, ${sql(m.acuerdo)}, ${sql(VALIDADO_POR)}, ${sql(VALIDADO_EN)})`,
  )
  .join(',\n')}
ON CONFLICT (municipio_codigo, anio, codigo_actividad) DO NOTHING;
`);
  }
}

const destino = path.join(__dirname, '..', 'db', 'migrations', '0093_reteica_municipios.sql');
fs.writeFileSync(destino, partes.join(''));
console.log(`Escribí ${destino}: ${total} actividades en ${MUNICIPIOS.length} municipios.`);
