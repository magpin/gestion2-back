// Arma una hoja con la plantilla base y la manda a Gotenberg.
//
// La comprobación que importa es **cuál fuente quedó adentro del PDF**. Si las
// `woff2` no viajan en el `multipart`, Chromium cae a la del contenedor
// —Liberation, Noto— y el PDF sale igual: no falla, sale con otra tipografía.
// Es la falla clásica de esta ruta y la única forma de verla es abrir el PDF y
// mirar, o mirar acá.
//
// Uso:
//   node scripts/verificar-plantilla-reportes.js
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

require('ts-node').register({ transpileOnly: true });

const { PlantillaService } = require('../src/modules/reportes/servicios/plantilla.service');
const { GotenbergService } = require('../src/modules/reportes/servicios/gotenberg.service');
const { GraficoService, TINTA } = require('../src/modules/reportes/servicios/grafico.service');

let pasadas = 0;
let fallidas = 0;
const revisar = (cond, que, detalle = '') => {
  if (cond) {
    pasadas += 1;
    console.log(`  OK    ${que}`);
  } else {
    fallidas += 1;
    console.log(`  FALLA ${que}${detalle ? ' -> ' + detalle : ''}`);
  }
};

/** Las fuentes que el PDF declara adentro. Vienen con un prefijo tipo `AAAAAA+`. */
const fuentesDe = (pdf) => [
  ...new Set(
    [...pdf.toString('latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map(
      (m) => m[1],
    ),
  ),
];

const hojaDe = (pdf) => {
  const m = /MediaBox\s*\[([^\]]*)\]/.exec(pdf.toString('latin1'));
  if (m === null) return null;
  const [, , ancho, alto] = m[1].trim().split(/\s+/).map(Number);
  return `${Math.round(ancho)}×${Math.round(alto)}`;
};

const paginasDe = (pdf) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

(async () => {
  console.log('\n=== La plantilla base ===\n');

  const plantillas = new PlantillaService();
  plantillas.onModuleInit();
  const gotenberg = new GotenbergService();
  const graficos = new GraficoService();

  console.log('1 · Las fuentes se encontraron');
  const soloFuentes = plantillas.armar({
    titulo: 'x',
    parametros: [],
    empresa: { razonSocial: 'x', nit: '1' },
    cuerpo: '',
  });
  const woff2 = Object.keys(soloFuentes.assets).filter((n) => n.endsWith('.woff2'));
  revisar(woff2.length === 5, 'las cinco caras van en el multipart', woff2.join(', '));
  revisar(
    Object.keys(soloFuentes.assets).includes('footer.html'),
    'y el pie va como archivo aparte, que es donde la paginación existe',
  );

  console.log('\n2 · Una hoja de verdad');
  const dona = await graficos.aPng(
    {
      type: 'doughnut',
      data: {
        labels: ['Cobrado', 'Por cobrar', 'Vencido'],
        datasets: [
          {
            data: [41.1, 22.4, 5.1],
            backgroundColor: [TINTA.resuelto, TINTA.tramos[2], TINTA.atencion],
            borderWidth: 0,
          },
        ],
      },
      options: { legend: { display: false }, cutoutPercentage: 72 },
    },
    150,
    150,
  );
  revisar(dona !== null, 'el gráfico se dibujó', dona ? `${dona.length} bytes` : 'null');

  const cuerpo = `
    <p>Esta hoja existe para comprobar la plantilla, no para leerla.</p>
    <p class="cifra">$ 68.575.000</p>
    <p class="atencion">Vencido: $ 5.100.000</p>
    ${dona ? '<img src="dona.png" width="120">' : ''}
    <div style="break-after:page"></div>
    <p>Segunda hoja, para que la numeración tenga de qué hablar.</p>`;

  const { html, assets } = plantillas.armar({
    titulo: 'Prueba de la plantilla base',
    parametros: ['1 – 30 sep 2026 · este mes', 'Ventas · agrupado por cliente'],
    empresa: {
      razonSocial: 'Distribuidora Andina S.A.S.',
      nit: '901.234.567',
      dv: '8',
      ciudad: 'Medellín, Antioquia',
    },
    elaboro: 'Carlos Rueda Mejía',
    cuerpo,
    assets: dona ? { 'dona.png': dona } : {},
  });

  const pdf = await gotenberg.aPdf(html, assets);
  revisar(pdf.subarray(0, 5).toString() === '%PDF-', 'vuelve un PDF');
  revisar(hojaDe(pdf) === '612×792', 'carta vertical', hojaDe(pdf) ?? '?');
  revisar(paginasDe(pdf) === 2, 'con sus dos páginas', String(paginasDe(pdf)));

  console.log('\n3 · La fuente, que es lo que falla en silencio');
  const fuentes = fuentesDe(pdf);
  console.log(`  ·     adentro del PDF: ${fuentes.join(', ')}`);
  revisar(
    fuentes.some((f) => f.includes('Inter')),
    'Inter viajó y se empotró',
  );
  revisar(
    fuentes.some((f) => f.includes('JetBrains')),
    'JetBrains Mono también, que es la de las cifras',
  );
  revisar(
    fuentes.filter((f) => f.includes('Inter')).length >= 2,
    'con más de una cara, que es lo que distingue un título de un renglón',
    fuentes.filter((f) => f.includes('Inter')).join(', '),
  );
  // La única ajena que puede quedar es la del pie. Chromium rinde el pie en un
  // contexto aislado que **no carga fuentes**: ni por nombre de archivo ni
  // empotrada en base64, las dos comprobadas. Si aparece otra, el cuerpo cayó a
  // la fuente del contenedor y el PDF está saliendo con la tipografía
  // equivocada sin fallar.
  const ajenas = fuentes.filter((f) => !/Inter|JetBrains|NotoSans/.test(f));
  revisar(
    ajenas.length === 0,
    'y el cuerpo no cayó a la fuente del contenedor',
    ajenas.join(', ') || '(ninguna)',
  );

  console.log('\n4 · La horizontal');
  const apaisada = plantillas.armar({
    titulo: 'Antigüedad de saldos de cartera',
    parametros: ['corte 21 sep 2026'],
    empresa: { razonSocial: 'Distribuidora Andina S.A.S.', nit: '901.234.567', dv: '8' },
    cuerpo: '<p>Horizontal.</p>',
    orientacion: 'HORIZONTAL',
  });
  const pdfH = await gotenberg.aPdf(apaisada.html, apaisada.assets);
  revisar(hojaDe(pdfH) === '792×612', 'carta acostada', hojaDe(pdfH) ?? '?');

  const destino = path.join(os.tmpdir(), 'plantilla-base.pdf');
  fs.writeFileSync(destino, pdf);
  console.log(`\n  ·     escrito en ${destino}`);

  console.log(`\n=== ${pasadas} bien, ${fallidas} mal ===\n`);
  process.exit(fallidas === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
