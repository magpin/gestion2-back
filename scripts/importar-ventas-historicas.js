// Importa las facturas de venta históricas —las emitidas antes de usar el
// sistema— desde un Excel. Fase 10 de `docs/planes/maria-facturas-y-errores.md`.
//
// Se cargan **con su número y su fecha originales, sin tocar la resolución, y
// sin asiento ni kardex**: lo que vendieron ya está en los saldos iniciales.
// Quedan para consultarlas y para cobrar lo que falte.
//
// Uso:
//   CLAVE_USUARIO='...' node scripts/importar-ventas-historicas.js \
//     --archivo "ventas-historicas.xlsx" \
//     --email contador@empresa.co \
//     --empresa 901234567 \        NIT (sin DV) o id de la empresa destino
//     [--simular]                  corre todo en el servidor y lo deshace
//
//   node scripts/importar-ventas-historicas.js --plantilla ventas-historicas.xlsx
//     escribe un Excel de ejemplo con las columnas que se esperan.
//
// El archivo: **una fila por línea de factura**, con encabezados en la primera
// fila. Las columnas se buscan por nombre, sin importar mayúsculas ni tildes, y
// admiten los nombres de la derecha:
//
//   NUMERO           numero, factura, no factura, documento
//   FECHA            fecha, fecha factura           (dd/mm/aaaa, aaaa-mm-dd o fecha de Excel)
//   NIT CLIENTE      nit, nit cliente, cedula, documento cliente, identificacion
//   CODIGO PRODUCTO  codigo, codigo producto, referencia, ref
//   CANTIDAD         cantidad, cant
//   PRECIO UNITARIO  precio, precio unitario, valor unitario, vr unitario   (antes de IVA)
//   IVA %            iva, iva %, tarifa iva, % iva   (0, 5 o 19)
//   PAGADO           pagado, abonado, valor pagado   (opcional; por factura)
//
// Las filas con el mismo número son la misma factura. **Todas o ninguna** por
// envío: el servidor valida todo antes de escribir, y si una factura tiene un
// problema no entra ninguna y se dice cuál y por qué. Un número que ya existe
// se rechaza, así que correrlo dos veces no duplica nada.
require('dotenv').config();

const { leerXlsx } = require('./lib/xlsx');
const { pedir, entrar } = require('./lib/api');

/** Cuántas facturas por envío: el servidor acepta hasta 500. */
const POR_ENVIO = 400;

const COLUMNAS = {
  numero: ['numero', 'factura', 'no factura', 'documento', 'numero factura'],
  fecha: ['fecha', 'fecha factura'],
  nit: ['nit cliente', 'nit', 'cedula', 'documento cliente', 'identificacion'],
  codigo: ['codigo producto', 'codigo', 'referencia', 'ref'],
  cantidad: ['cantidad', 'cant'],
  precio: ['precio unitario', 'precio', 'valor unitario', 'vr unitario'],
  iva: ['iva %', 'iva', 'tarifa iva', '% iva'],
  pagado: ['pagado', 'abonado', 'valor pagado'],
};
const OBLIGATORIAS = ['numero', 'fecha', 'nit', 'codigo', 'cantidad', 'precio', 'iva'];

function argumentos() {
  const args = process.argv.slice(2);
  const valores = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const clave = args[i].slice(2);
    const siguiente = args[i + 1];
    if (siguiente === undefined || siguiente.startsWith('--')) valores[clave] = true;
    else {
      valores[clave] = siguiente;
      i += 1;
    }
  }
  return valores;
}

const comparable = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.#°º]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Qué columna es cada dato, por el encabezado. */
function ubicarColumnas(encabezado) {
  const nombres = encabezado.map(comparable);
  const donde = {};
  for (const [dato, alias] of Object.entries(COLUMNAS)) {
    const i = nombres.findIndex((n) => alias.includes(n));
    if (i >= 0) donde[dato] = i;
  }
  const faltan = OBLIGATORIAS.filter((d) => donde[d] === undefined);
  if (faltan.length > 0) {
    throw new Error(
      `No encontré estas columnas: ${faltan.map((d) => COLUMNAS[d][0].toUpperCase()).join(', ')}. ` +
        `Encabezados del archivo: ${encabezado.filter(Boolean).join(' | ')}`,
    );
  }
  return donde;
}

/** Excel guarda las fechas como días desde el 30/12/1899, o el archivo trae texto. */
function fecha(valor) {
  const texto = String(valor ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(texto) && Number(texto) > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(texto)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const dma = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(texto);
  if (dma) return `${dma[3]}-${dma[2].padStart(2, '0')}-${dma[1].padStart(2, '0')}`;
  return texto.slice(0, 10);
}

/** «$ 1.234.567,50», «1234567.5», «19%» → número. */
function numero(valor) {
  if (typeof valor === 'number') return valor;
  let t = String(valor ?? '').replace(/[$%\s]/g, '');
  if (t === '') return NaN;
  // Con coma decimal a la colombiana: los puntos son de miles.
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return Number(t.replace(/,/g, ''));
}

/** Las filas del Excel, agrupadas en facturas por su número. */
function armarFacturas(filas) {
  const [encabezado, ...datos] = filas;
  const col = ubicarColumnas(encabezado ?? []);
  const porNumero = new Map();
  datos.forEach((f) => {
    const num = String(f[col.numero] ?? '').trim();
    if (num === '') return;
    const factura = porNumero.get(num) ?? {
      numero: num,
      fecha: fecha(f[col.fecha]),
      clienteNit: String(f[col.nit] ?? '').trim(),
      lineas: [],
    };
    factura.lineas.push({
      codigoProducto: String(f[col.codigo] ?? '').trim(),
      cantidad: numero(f[col.cantidad]),
      precioUnitario: numero(f[col.precio]),
      ivaTarifa: numero(f[col.iva]),
    });
    if (col.pagado !== undefined && factura.pagado === undefined) {
      const pagado = numero(f[col.pagado]);
      if (!Number.isNaN(pagado)) factura.pagado = pagado;
    }
    porNumero.set(num, factura);
  });
  return [...porNumero.values()];
}

async function escribirPlantilla(ruta) {
  const ExcelJS = require('exceljs');
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Ventas históricas');
  hoja.addRow(['NUMERO', 'FECHA', 'NIT CLIENTE', 'CODIGO PRODUCTO', 'CANTIDAD', 'PRECIO UNITARIO', 'IVA %', 'PAGADO']);
  hoja.addRow(['FV-1021', '15/06/2026', '900746054', '11111500', 5, 20000, 19, 119000]);
  hoja.addRow(['FV-1021', '15/06/2026', '900746054', '11012200', 1, 90000, 19, '']);
  hoja.addRow(['FV-1022', '18/06/2026', '900970799', '11111500', 2, 20000, 19, 0]);
  hoja.getRow(1).font = { bold: true };
  hoja.columns.forEach((c) => (c.width = 18));
  await libro.xlsx.writeFile(ruta);
  console.log(`Plantilla escrita en ${ruta}. Una fila por línea; PAGADO va en la primera fila de cada factura.`);
}

(async () => {
  const a = argumentos();
  if (typeof a.plantilla === 'string') {
    await escribirPlantilla(a.plantilla);
    return;
  }
  const faltan = ['archivo', 'email', 'empresa'].filter((k) => !a[k]);
  if (faltan.length > 0) {
    console.error(`Faltan argumentos: ${faltan.map((f) => '--' + f).join(', ')}`);
    console.error('Ver el encabezado de este archivo para el uso completo.');
    process.exit(1);
  }
  if (!process.env.CLAVE_USUARIO) {
    console.error('Falta CLAVE_USUARIO en el entorno (la contraseña del usuario que importa).');
    process.exit(1);
  }
  const simular = a.simular === true;

  const facturas = armarFacturas(leerXlsx(a.archivo));
  console.log(`${facturas.length} facturas en el archivo, ${facturas.reduce((s, f) => s + f.lineas.length, 0)} líneas.`);

  const sesion = await entrar(a.email, process.env.CLAVE_USUARIO, a.empresa);
  console.log(`Empresa destino: ${sesion.empresa.razonSocial}${simular ? ' — SIMULACIÓN' : ''}`);

  let registradas = 0;
  for (let i = 0; i < facturas.length; i += POR_ENVIO) {
    const envio = facturas.slice(i, i + POR_ENVIO);
    const r = await pedir('POST', `/facturas-historicas${simular ? '?simular=true' : ''}`, {
      token: sesion.token,
      cuerpo: { facturas: envio },
    });
    if (r.estado >= 300) {
      console.error(`El servidor rechazó el envío (${r.estado}): ${JSON.stringify(r.datos)}`);
      process.exit(1);
    }
    if (r.datos.problemas.length > 0) {
      console.error(`\nNo se cargó ninguna factura de este envío. Problemas:`);
      for (const p of r.datos.problemas) {
        console.error(`  ${p.numero}: ${p.problemas.join(' ')}`);
      }
      process.exit(1);
    }
    registradas += r.datos.registradas;
  }
  console.log(`${simular ? 'Se cargarían' : 'Se cargaron'} ${registradas} facturas históricas.`);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
