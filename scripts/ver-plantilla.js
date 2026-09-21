// Sirve una hoja armada con la plantilla, para mirarla en el navegador.
//
// Existe para no tener que generar un PDF en cada cambio: se edita un `.hbs` o
// el `reporte.css`, se recarga la página y se ve. Con `Ctrl+P` el navegador
// imprime lo mismo que va a salir de Gotenberg, porque el tamaño de hoja vive
// en la regla `@page` del CSS y no en los parámetros de la llamada.
//
// No es la vista previa del producto —esa es el paso 7 y va adentro de la
// aplicación—: es una herramienta para construir las plantillas.
//
// Uso:
//   node scripts/ver-plantilla.js          # http://localhost:3020
//   node scripts/ver-plantilla.js 3030
require('dotenv').config();
const http = require('node:http');

require('ts-node').register({ transpileOnly: true });

const { PlantillaService } = require('../src/modules/reportes/servicios/plantilla.service');
const { GraficoService, TINTA } = require('../src/modules/reportes/servicios/grafico.service');

const PUERTO = Number(process.argv[2] ?? 3020);

const TIPOS = {
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
};

(async () => {
  const plantillas = new PlantillaService();
  plantillas.onModuleInit();
  const graficos = new GraficoService();

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
    cuerpo: `
      <p>Un párrafo de cuerpo, para ver cómo cae Inter en 10,5 px.</p>
      <p>Una cifra en mono: <span class="cifra">$ 68.575.000</span>, y otra que
         exige atención: <span class="cifra atencion">$ 5.100.000</span>.</p>
      ${dona ? '<img src="dona.png" width="120" alt="">' : '<p>(sin gráfico: QuickChart no contestó)</p>'}`,
    assets: dona ? { 'dona.png': dona } : {},
  });

  http
    .createServer((peticion, respuesta) => {
      const nombre = (peticion.url ?? '/').replace(/^\//, '').split('?')[0];

      if (nombre === '' || nombre === 'index.html') {
        respuesta.writeHead(200, { 'content-type': TIPOS['.html'] });
        respuesta.end(html);
        return;
      }
      // El pie no se sirve: lo imprime Chromium en el PDF, y en pantalla no
      // existe porque no hay páginas que numerar.
      const archivo = assets[nombre];
      if (archivo !== undefined && nombre !== 'footer.html') {
        const extension = nombre.slice(nombre.lastIndexOf('.'));
        respuesta.writeHead(200, { 'content-type': TIPOS[extension] ?? 'application/octet-stream' });
        respuesta.end(archivo);
        return;
      }
      respuesta.writeHead(404).end();
    })
    .listen(PUERTO, () => {
      console.log(`\n  La hoja en http://localhost:${PUERTO}`);
      console.log('  Ctrl+P imprime lo mismo que sale de Gotenberg.\n');
    });
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
