// Sirve «Ventas del mes por cliente» en el navegador y escribe su PDF.
//
// Corre **con los datos del diseño**, no con la base: el armador es puro y la
// plantilla solo dibuja, así que esto muestra exactamente lo que va a salir
// cuando haya facturas de verdad. Mientras la base local esté vacía, es la
// única forma de ver la hoja completa.
//
// Uso:
//   node scripts/ver-reporte-ventas.js          # http://localhost:3021 y un PDF
//   node scripts/ver-reporte-ventas.js --solo-pdf
require('dotenv').config();
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true });

const { armar, DIAS_PARA_VENCER } = require('../src/modules/reportes/reportes/ventas-por-cliente');
const { PlantillaService } = require('../src/modules/reportes/servicios/plantilla.service');
const { GotenbergService } = require('../src/modules/reportes/servicios/gotenberg.service');
const { GraficoService, TINTA } = require('../src/modules/reportes/servicios/grafico.service');

const PUERTO = 3021;
const RANGO = { desde: '2026-09-01', hasta: '2026-09-30', etiqueta: 'este mes' };

/**
 * Los del diseño, en `docs/reportes-pdf-diseno/VentasPorCliente-pag2.dc.html`.
 *
 * **Con una fecha cambiada, y hay que decirlo.** El diseño muestra la FV-1038
 * como vencida con fecha del 12 de septiembre, a dieciocho días del corte. Eso
 * solo se sostiene si la factura tenía un plazo pactado, y el sistema **no
 * guarda plazos**: lo único que puede afirmar es «con saldo y emitida hace más
 * de treinta días». Acá se le puso fecha de agosto para que el caso vencido se
 * vea; la prueba unitaria usa la fecha literal del diseño y, correctamente,
 * no la marca vencida.
 */
const f = (cliente, numero, fecha, total, pagado, estado = 'EMITIDA') => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado,
  total: total.toFixed(2),
  pagado: pagado.toFixed(2),
});

const FACTURAS = [
  f('Constructora Meridiano', 'FV-1033', '2026-09-04', 7_600_000, 7_600_000),
  f('Constructora Meridiano', 'FV-1041', '2026-09-17', 14_200_000, 14_200_000),
  f('Constructora Meridiano', 'FV-1046', '2026-09-20', 7_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1038', '2026-08-12', 5_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1042', '2026-09-18', 8_930_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1045', '2026-09-19', 5_100_000, 5_100_000),
  f('Ferretería El Tornillo', 'FV-1034', '2026-09-05', 2_750_000, 2_750_000),
  f('Ferretería El Tornillo', 'FV-1040', '2026-09-16', 3_480_000, 2_280_000),
  f('Distribuciones Norte', 'FV-1031', '2026-09-02', 4_150_000, 4_150_000),
  f('Distribuciones Norte', 'FV-1037', '2026-09-10', 0, 0, 'ANULADA'),
  f('Inversiones La Loma S.A.S.', 'FV-1047', '2026-09-20', 3_960_000, 0),
  f('Cliente de mostrador', 'FV-1032', '2026-09-03', 380_000, 380_000),
  f('Cliente de mostrador', 'FV-1036', '2026-09-08', 915_000, 915_000),
  f('Cliente de mostrador', 'FV-1039', '2026-09-15', 620_000, 620_000),
  f('Cliente de mostrador', 'FV-1044', '2026-09-19', 1_240_000, 1_240_000),
  f('Jorge Restrepo', 'FV-1035', '2026-09-06', 1_850_000, 1_850_000),
  f('Jorge Restrepo', 'FV-1043', '2026-09-18', 1_200_000, 0),
];

const TIPOS = { '.woff2': 'font/woff2', '.png': 'image/png' };

(async () => {
  const plantillas = new PlantillaService();
  plantillas.onModuleInit();
  const graficos = new GraficoService();
  const gotenberg = new GotenbergService();

  const datos = armar(FACTURAS, RANGO);
  const assets = {};
  const nombres = {};

  const porDia = await graficos.aPng(
    {
      type: 'bar',
      data: {
        labels: datos.porDia.map((d, i) => (datos.escala === 'MES' || i % 7 === 0 ? d.rotulo : '')),
        datasets: [
          {
            data: datos.porDia.map((d) => d.valor / 100_000_000),
            backgroundColor: datos.porDia.map((d) =>
              datos.pico && d.clave === datos.pico.clave ? TINTA.atencion : TINTA.resuelto,
            ),
            borderWidth: 0,
            barPercentage: 0.75,
          },
        ],
      },
      options: {
        scales: {
          xAxes: [
            {
              gridLines: { display: false, drawBorder: false },
              ticks: {
                fontColor: TINTA.apagado,
                fontSize: 9,
                autoSkip: false,
                maxRotation: 0,
                minRotation: 0,
              },
            },
          ],
          yAxes: [
            {
              gridLines: { color: '#ededed', drawBorder: false },
              ticks: { fontColor: TINTA.apagado, fontSize: 9, maxTicksLimit: 4, beginAtZero: true },
            },
          ],
        },
      },
    },
    430,
    140,
  );
  if (porDia) {
    assets['ventas-por-dia.png'] = porDia;
    nombres.porDia = 'ventas-por-dia.png';
  }

  const estado = await graficos.aPng(
    {
      type: 'doughnut',
      data: {
        labels: ['Cobrado', 'Por cobrar', 'Vencido'],
        datasets: [
          {
            data: [
              datos.resumen.tramos.cobrado,
              datos.resumen.tramos.porCobrarAlDia,
              datos.resumen.tramos.vencido,
            ],
            backgroundColor: [TINTA.resuelto, TINTA.tramos[2], TINTA.atencion],
            borderWidth: 0,
          },
        ],
      },
      options: { cutoutPercentage: 74 },
    },
    150,
    150,
  );
  if (estado) {
    assets['estado-de-cobro.png'] = estado;
    nombres.estado = 'estado-de-cobro.png';
  }

  const cuerpo = plantillas.cuerpo('ventas-por-cliente', {
    ...datos,
    graficos: nombres,
    diasParaVencer: DIAS_PARA_VENCER,
    elaboro: 'Camila Torres',
    rol: 'Contador',
  });

  const hoja = plantillas.armar({
    titulo: 'Ventas del mes por cliente',
    parametros: [
      `1 – 30 sep 2026 · ${RANGO.etiqueta}`,
      'Ventas · facturas · agrupado por cliente',
    ],
    empresa: {
      razonSocial: 'Distribuidora Andina S.A.S.',
      nit: '901.234.567',
      dv: '8',
      ciudad: 'Medellín, Antioquia',
    },
    elaboro: 'Camila Torres',
    cuerpo,
    assets,
  });

  console.log(`\n  ${datos.resumen.totalFacturado} · ${datos.resumen.facturas} facturas · ${datos.resumen.clientes} clientes`);
  console.log(`  cobrado ${datos.resumen.cobrado} (${datos.resumen.cobradoPorciento} %) · por cobrar ${datos.resumen.porCobrar} · vencido ${datos.resumen.vencido}`);

  const pdf = await gotenberg.aPdf(hoja.html, hoja.assets);
  const destino = path.join(os.tmpdir(), 'ventas-por-cliente.pdf');
  fs.writeFileSync(destino, pdf);
  const paginas = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`  PDF: ${Math.round(pdf.length / 1024)} KB · ${paginas} páginas · ${destino}`);

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
