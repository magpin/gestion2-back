// ¿Están arriba Gotenberg y QuickChart, y hacen lo que hace falta?
//
// Es lo primero que hay que correr antes de tocar una plantilla. Si Gotenberg no
// contesta, todo lo que venga después falla por otra razón y se pierde la tarde
// buscando dónde.
//
// No comprueba que contesten: comprueba que **devuelvan lo que dicen**. Un PDF
// de cero bytes también responde 200.
//
// Uso:
//   node scripts/verificar-reportes-sidecars.js
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

const GOTENBERG = process.env.GOTENBERG_URL ?? 'http://localhost:3010';
const QUICKCHART = process.env.QUICKCHART_URL ?? 'http://localhost:3400';

let pasadas = 0;
let fallidas = 0;

function revisar(condicion, descripcion, detalle = '') {
  if (condicion) {
    pasadas += 1;
    console.log(`  OK    ${descripcion}`);
  } else {
    fallidas += 1;
    console.log(`  FALLA ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
  }
}

/**
 * El tamaño real de la hoja, leído del PDF. En puntos: carta vertical es
 * 612 × 792 y horizontal 792 × 612.
 *
 * Se mira acá porque **es lo que se ignora en silencio**: una regla `@page` en
 * el CSS le gana a `paperWidth`/`paperHeight`, y el PDF sale del tamaño
 * equivocado sin un solo error.
 */
function hojaDe(pdf) {
  const texto = pdf.toString('latin1');
  const m = /MediaBox\s*\[([^\]]*)\]/.exec(texto);
  if (m === null) return null;
  const [, , ancho, alto] = m[1].trim().split(/\s+/).map(Number);
  return `${Math.round(ancho)}×${Math.round(alto)}`;
}

/**
 * El HTML y sus archivos, en un solo `multipart`. Gotenberg los escribe juntos
 * en una carpeta y abre `index.html`, así que el HTML los referencia por nombre.
 *
 * **Los assets van adentro y no por URL**, y esto costó descubrirlo: desde el
 * contenedor de Gotenberg, `localhost` es Gotenberg, no el host. Un
 * `<img src="http://localhost:3400/chart?...">` no carga y **el PDF sale igual**,
 * sin el gráfico y sin un solo error. Es la misma trampa de las dos direcciones
 * que `S3_ENDPOINT` y `S3_ENDPOINT_PUBLICO` ya resuelven para MinIO.
 *
 * Embeberlos evita además depender de que Gotenberg tenga red, que en
 * producción es una cosa menos que puede fallar a mitad de un reporte.
 */
async function aPdf(html, assets = {}) {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  for (const [nombre, buf] of Object.entries(assets)) {
    form.append('files', new Blob([buf]), nombre);
  }
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Gotenberg respondió ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const hoja = (medida) => `<!doctype html><html><head><meta charset="utf-8">
<style>@page{size:${medida};margin:0.54in 0.67in 0.46in}
body{font-family:sans-serif}</style></head>
<body><h1>Prueba</h1></body></html>`;

(async () => {
  console.log('\n=== Los dos contenedores de los reportes ===\n');
  console.log(`    Gotenberg:  ${GOTENBERG}`);
  console.log(`    QuickChart: ${QUICKCHART}\n`);

  // ---------------------------------------------------------------- Gotenberg
  console.log('1 · Gotenberg');
  try {
    const salud = await fetch(`${GOTENBERG}/health`).then((r) => r.json());
    revisar(salud.status === 'up', 'contesta y se declara arriba');
    revisar(
      salud.details?.chromium?.status === 'up',
      'con Chromium adentro, que es el que arma el PDF',
    );
  } catch (e) {
    revisar(false, 'contesta', e.message);
    console.log('\n  Sin Gotenberg no hay nada más que probar.\n');
    process.exit(1);
  }

  const vertical = await aPdf(hoja('8.5in 11in'));
  revisar(
    vertical.subarray(0, 5).toString() === '%PDF-',
    'un HTML vuelve como PDF de verdad',
    `${vertical.length} bytes, empieza con «${vertical.subarray(0, 5).toString()}»`,
  );
  revisar(hojaDe(vertical) === '612×792', 'carta vertical', hojaDe(vertical) ?? '?');

  const horizontal = await aPdf(hoja('11in 8.5in'));
  revisar(
    hojaDe(horizontal) === '792×612',
    'carta horizontal, que es la de cartera',
    hojaDe(horizontal) ?? '?',
  );

  // --------------------------------------------------------------- QuickChart
  console.log('\n2 · QuickChart');
  const version = await fetch(`${QUICKCHART}/healthcheck`)
    .then((r) => r.json())
    .catch(() => null);
  revisar(version?.success === true, 'contesta', JSON.stringify(version));

  // La sintaxis es de **Chart.js v2**: `options.legend`, no
  // `options.plugins.legend`; `cutoutPercentage`, no `cutout`. Con la de v3 las
  // opciones se ignoran sin avisar y el gráfico sale con leyenda.
  const config = {
    type: 'doughnut',
    data: {
      labels: ['Cobrado', 'Por cobrar', 'Vencido'],
      datasets: [
        {
          data: [41.1, 22.4, 5.1],
          backgroundColor: ['#171717', '#b8b8b8', '#f25623'],
          borderWidth: 0,
        },
      ],
    },
    options: { legend: { display: false }, cutoutPercentage: 72 },
  };
  const url = `${QUICKCHART}/chart?w=300&h=300&backgroundColor=transparent&c=${encodeURIComponent(JSON.stringify(config))}`;
  const png = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));

  revisar(
    png.subarray(1, 4).toString() === 'PNG',
    'una configuración de Chart.js vuelve como PNG',
    `${png.length} bytes`,
  );
  // Pedimos 300 y vuelven 600: dibuja al doble, que es lo que hace que no se
  // vea pixelado en el papel.
  const ancho = png.readUInt32BE(16);
  revisar(ancho === 600, 'al doble de lo pedido, para que imprima nítido', `${ancho} px`);

  // ------------------------------------------------------------------- Juntos
  console.log('\n3 · Los dos juntos');

  // Primero lo que NO hay que hacer, porque falla sin decirlo: el PDF sale
  // igual, más liviano, y sin el gráfico. Si algún día esto empieza a pasar,
  // la comprobación de abajo lo delata.
  const porUrl = await aPdf(
    `<!doctype html><html><head><meta charset="utf-8">
     <style>@page{size:8.5in 11in;margin:0}</style></head>
     <body><img src="${url}" width="220"></body></html>`,
  );

  const pdfConGrafico = await aPdf(
    `<!doctype html><html><head><meta charset="utf-8">
     <style>@page{size:8.5in 11in;margin:0.54in 0.67in 0.46in}</style></head>
     <body><img src="grafico.png" width="220"></body></html>`,
    { 'grafico.png': png },
  );
  revisar(
    pdfConGrafico.length > porUrl.length * 2,
    'el gráfico embebido entra en el PDF',
    `${pdfConGrafico.length} bytes`,
  );
  revisar(
    porUrl.length < pdfConGrafico.length,
    'y por URL no entra — Gotenberg no alcanza el host',
    `por URL ${porUrl.length} bytes, embebido ${pdfConGrafico.length}`,
  );

  const destino = path.join(os.tmpdir(), 'prueba-reportes.pdf');
  fs.writeFileSync(destino, pdfConGrafico);
  console.log(`  ·     escrito en ${destino} — abrilo para verlo`);

  console.log(`\n=== ${pasadas} bien, ${fallidas} mal ===\n`);
  process.exit(fallidas === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
