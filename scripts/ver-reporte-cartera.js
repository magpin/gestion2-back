// Sirve «Antigüedad de saldos de cartera» en el navegador y escribe su PDF.
//
// Con los datos del diseño, igual que `ver-reporte-ventas.js`: el armador es
// puro, así que esto muestra exactamente lo que va a salir cuando haya facturas
// con saldo en la base.
//
// Uso:
//   node scripts/ver-reporte-cartera.js          # http://localhost:3022 y un PDF
//   node scripts/ver-reporte-cartera.js --solo-pdf
require('dotenv').config();
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true });

const { armar } = require('../src/modules/reportes/reportes/antiguedad-cartera');
const { DIAS_PARA_VENCER } = require('../src/modules/reportes/reportes/ventas-por-cliente');
const { PlantillaService } = require('../src/modules/reportes/servicios/plantilla.service');
const { GotenbergService } = require('../src/modules/reportes/servicios/gotenberg.service');

const PUERTO = 3022;
const CORTE = '2026-09-21';

/**
 * Los ocho clientes del diseño, en `AntiguedadDeCartera.dc.html`, repartidos
 * en fechas que caen en el tramo que el diseño les da. Los cinco tramos suman
 * los $ 40.070.000 de la cifra principal.
 */
const EN = {
  sinVencer: '2026-09-10',
  d1a30: '2026-08-10',
  d31a60: '2026-07-10',
  d61a90: '2026-06-10',
  masDe90: '2026-03-10',
};

const f = (cliente, numero, fecha, saldo) => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado: 'EMITIDA',
  total: saldo.toFixed(2),
  pagado: '0.00',
});

const PENDIENTES = [
  f('Almacenes del Sur S.A.S.', 'FV-1042', EN.sinVencer, 8_930_000),
  f('Almacenes del Sur S.A.S.', 'FV-1038', EN.d1a30, 5_100_000),
  f('Constructora Meridiano', 'FV-1046', EN.sinVencer, 7_100_000),
  f('Suministros Andes Ltda.', 'FV-0980', EN.masDe90, 4_850_000),
  f('Inversiones La Loma S.A.S.', 'FV-1047', EN.sinVencer, 3_960_000),
  f('Comercial Aburrá', 'FV-1010', EN.d1a30, 1_470_000),
  f('Comercial Aburrá', 'FV-0995', EN.d31a60, 2_080_000),
  f('Obras y Montajes del Valle', 'FV-0990', EN.d61a90, 3_200_000),
  f('Ferretería El Tornillo', 'FV-1040', EN.sinVencer, 1_200_000),
  f('Ferretería El Tornillo', 'FV-1020', EN.d1a30, 980_000),
  f('Jorge Restrepo', 'FV-1043', EN.sinVencer, 1_200_000),
];

const TIPOS = { '.woff2': 'font/woff2', '.png': 'image/png' };

(async () => {
  const plantillas = new PlantillaService();
  plantillas.onModuleInit();
  const gotenberg = new GotenbergService();

  const datos = armar(PENDIENTES, CORTE, DIAS_PARA_VENCER);

  const cuerpo = plantillas.cuerpo('antiguedad-cartera', {
    ...datos,
    elaboro: 'Camila Torres',
    rol: 'Contador',
  });

  const hoja = plantillas.armar({
    titulo: 'Antigüedad de saldos de cartera',
    parametros: [`corte 21 sep 2026`, 'Cartera por cobrar · saldo mayor a $ 0'],
    empresa: {
      razonSocial: 'Distribuidora Andina S.A.S.',
      nit: '901.234.567',
      dv: '8',
      ciudad: 'Medellín, Antioquia',
    },
    elaboro: 'Camila Torres',
    cuerpo,
    orientacion: 'HORIZONTAL',
    conFirmas: false,
  });

  console.log(`\n  ${datos.resumen.total} · ${datos.resumen.clientes} clientes`);
  console.log(
    `  al día ${datos.resumen.alDia} (${datos.resumen.alDiaPorciento} %) · ` +
      `vencida ${datos.resumen.vencida} (${datos.resumen.vencidaPorciento} %) · ` +
      `+90 ${datos.resumen.masDe90}`,
  );
  console.log('  tramos: ' + datos.tramos.map((t) => `${t.etiqueta} ${t.monto}`).join(' · '));

  const pdf = await gotenberg.aPdf(hoja.html, hoja.assets);
  const destino = path.join(os.tmpdir(), 'antiguedad-cartera.pdf');
  fs.writeFileSync(destino, pdf);
  const t = pdf.toString('latin1');
  console.log(
    `  PDF: ${Math.round(pdf.length / 1024)} KB · ` +
      `${(t.match(/\/Type\s*\/Page[^s]/g) ?? []).length} página(s) · ` +
      `hoja ${(/MediaBox\s*\[([^\]]*)\]/.exec(t) ?? [])[1]} · ${destino}`,
  );

  if (process.argv.includes('--solo-pdf')) return;

  http
    .createServer((peticion, respuesta) => {
      const nombre = (peticion.url ?? '/').replace(/^\//, '').split('?')[0];
      if (nombre === '' || nombre === 'index.html') {
        respuesta.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        respuesta.end(hoja.html);
        return;
      }
      const archivo = hoja.assets[nombre];
      if (archivo !== undefined && nombre !== 'footer.html') {
        const extension = nombre.slice(nombre.lastIndexOf('.'));
        respuesta.writeHead(200, { 'content-type': TIPOS[extension] ?? 'application/octet-stream' });
        respuesta.end(archivo);
        return;
      }
      respuesta.writeHead(404).end();
    })
    .listen(PUERTO, () => console.log(`  La hoja en http://localhost:${PUERTO}\n`));
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
