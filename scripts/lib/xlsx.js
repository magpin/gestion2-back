// Lector de .xlsx sin dependencias: un .xlsx es un zip con XML adentro.
//
// Cubre lo que exportan los sistemas contables —una hoja, celdas de texto o
// número, cadenas compartidas— y nada más. No es una librería de Excel.
const fs = require('fs');
const zlib = require('zlib');

function entradasZip(buf) {
  // Fin del directorio central: firma 0x06054b50, buscada desde el final.
  let fin = buf.length - 22;
  while (fin >= 0 && buf.readUInt32LE(fin) !== 0x06054b50) fin -= 1;
  if (fin < 0) throw new Error('No es un archivo zip/xlsx');
  const total = buf.readUInt16LE(fin + 10);
  let pos = buf.readUInt32LE(fin + 16);
  const entradas = {};
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Directorio zip corrupto');
    const metodo = buf.readUInt16LE(pos + 10);
    const tamanoComprimido = buf.readUInt32LE(pos + 20);
    const largoNombre = buf.readUInt16LE(pos + 28);
    const largoExtra = buf.readUInt16LE(pos + 30);
    const largoComentario = buf.readUInt16LE(pos + 32);
    const offsetLocal = buf.readUInt32LE(pos + 42);
    const nombre = buf.toString('utf8', pos + 46, pos + 46 + largoNombre);
    entradas[nombre] = { metodo, tamanoComprimido, offsetLocal };
    pos += 46 + largoNombre + largoExtra + largoComentario;
  }
  return entradas;
}

function leerEntrada(buf, e) {
  const largoNombre = buf.readUInt16LE(e.offsetLocal + 26);
  const largoExtra = buf.readUInt16LE(e.offsetLocal + 28);
  const inicio = e.offsetLocal + 30 + largoNombre + largoExtra;
  const datos = buf.subarray(inicio, inicio + e.tamanoComprimido);
  return (e.metodo === 8 ? zlib.inflateRawSync(datos) : datos).toString('utf8');
}

function desescapar(s) {
  return s
    .replace(/_x000D_/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function columna(ref) {
  let n = 0;
  for (const c of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Devuelve las filas de la primera hoja como arreglos de texto. */
function leerXlsx(ruta) {
  const buf = fs.readFileSync(ruta);
  const entradas = entradasZip(buf);
  const compartidas = [];
  if (entradas['xl/sharedStrings.xml']) {
    const xml = leerEntrada(buf, entradas['xl/sharedStrings.xml']);
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      compartidas.push(
        desescapar([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')),
      );
    }
  }
  const hoja = Object.keys(entradas)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  const xml = leerEntrada(buf, entradas[hoja]);
  const filas = [];
  for (const fila of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = [];
    for (const c of fila[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[2] || '';
      const cuerpo = c[3] || '';
      let valor = null;
      const v = cuerpo.match(/<v>([\s\S]*?)<\/v>/);
      if (/t="s"/.test(attrs) && v) valor = compartidas[Number(v[1])];
      else if (/t="inlineStr"/.test(attrs)) {
        valor = desescapar([...cuerpo.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
      } else if (v) valor = desescapar(v[1]);
      celdas[columna(c[1])] = valor;
    }
    filas.push(celdas);
  }
  return filas;
}

module.exports = { leerXlsx };
