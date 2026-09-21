import { inflateRawSync } from 'zlib';

import type { ArchivoParaLeer } from '../proveedores/extractor.puerto';

/**
 * Qué se puede subir al asistente, y cómo le llega cada cosa al modelo.
 *
 * La API de Claude recibe PDF e imágenes tal cual. **Lo demás lo convierte el
 * código a texto**: un Excel o un Word son un zip con XML adentro, y un CSV, un
 * XML o un JSON ya son texto. Lo que no se puede abrir no se le manda al
 * modelo: se dice.
 */

/** Tipo MIME → extensión de la llave en el bucket. */
export const TIPOS_SUBIBLES: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel', 'xls'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  ['text/csv', 'csv'],
  ['text/plain', 'txt'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
  ['application/json', 'json'],
  // Lo que el navegador no sabe nombrar. Se mira adentro: si es texto, se lee.
  ['application/octet-stream', 'bin'],
]);

/** Lo más largo que se le manda como texto: unas 30.000 palabras. */
const MAXIMO_TEXTO = 120_000;

export type ContenidoArchivo =
  | { forma: 'document' }
  | { forma: 'image' }
  | { forma: 'texto'; texto: string; recortado: boolean };

/** Cómo va el archivo al modelo, o `null` si no se puede abrir. */
export function contenidoDe(archivo: ArchivoParaLeer): ContenidoArchivo | null {
  const { tipoMime, contenido } = archivo;
  if (tipoMime === 'application/pdf') return { forma: 'document' };
  if (tipoMime.startsWith('image/')) return { forma: 'image' };

  let texto: string | null = null;
  try {
    if (tipoMime.includes('spreadsheetml')) texto = textoDeXlsx(contenido);
    else if (tipoMime.includes('wordprocessingml'))
      texto = textoDeDocx(contenido);
    // Un .xls de verdad es binario y no se abre; pero muchos sistemas
    // exportan HTML o XML con esa extensión, y eso sí es texto.
    else if (pareceTexto(contenido)) texto = contenido.toString('utf8');
  } catch {
    texto = null;
  }
  if (texto === null || texto.trim() === '') return null;
  return texto.length > MAXIMO_TEXTO
    ? { forma: 'texto', texto: texto.slice(0, MAXIMO_TEXTO), recortado: true }
    : { forma: 'texto', texto, recortado: false };
}

/** Sin bytes nulos en el comienzo: es texto, no un binario. */
function pareceTexto(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

// ── Zip ─────────────────────────────────────────────────────────────────

interface EntradaZip {
  metodo: number;
  tamanoComprimido: number;
  offsetLocal: number;
}

function entradasZip(buf: Buffer): Map<string, EntradaZip> {
  // Fin del directorio central: firma 0x06054b50, buscada desde el final.
  let fin = buf.length - 22;
  while (fin >= 0 && buf.readUInt32LE(fin) !== 0x06054b50) fin -= 1;
  if (fin < 0) throw new Error('No es un zip');
  const total = buf.readUInt16LE(fin + 10);
  let pos = buf.readUInt32LE(fin + 16);
  const entradas = new Map<string, EntradaZip>();
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Zip corrupto');
    const largoNombre = buf.readUInt16LE(pos + 28);
    entradas.set(buf.toString('utf8', pos + 46, pos + 46 + largoNombre), {
      metodo: buf.readUInt16LE(pos + 10),
      tamanoComprimido: buf.readUInt32LE(pos + 20),
      offsetLocal: buf.readUInt32LE(pos + 42),
    });
    pos +=
      46 +
      largoNombre +
      buf.readUInt16LE(pos + 30) +
      buf.readUInt16LE(pos + 32);
  }
  return entradas;
}

function leerEntrada(buf: Buffer, e: EntradaZip): string {
  const inicio =
    e.offsetLocal +
    30 +
    buf.readUInt16LE(e.offsetLocal + 26) +
    buf.readUInt16LE(e.offsetLocal + 28);
  const datos = buf.subarray(inicio, inicio + e.tamanoComprimido);
  return (e.metodo === 8 ? inflateRawSync(datos) : datos).toString('utf8');
}

function desescapar(s: string): string {
  return s
    .replace(/_x000D_/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const textos = (xml: string) =>
  [...xml.matchAll(/<(?:w:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:)?t>/g)]
    .map((m) => desescapar(m[1]))
    .join('');

// ── Excel ───────────────────────────────────────────────────────────────

/** Un serial de fecha de Excel a aaaa-mm-dd. */
const fechaExcel = (n: number) =>
  new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000)
    .toISOString()
    .slice(0, 10);

function columna(ref: string): number {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A')
    n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Todas las hojas, cada una como tabla separada por tabuladores. Las fechas
 * vienen como número de días: se convierten en las columnas cuyo encabezado
 * dice fecha, vence o emisión —el modelo no hace esa cuenta bien—.
 */
export function textoDeXlsx(buf: Buffer): string {
  const entradas = entradasZip(buf);
  const compartidas: string[] = [];
  const cadenas = entradas.get('xl/sharedStrings.xml');
  if (cadenas) {
    for (const si of leerEntrada(buf, cadenas).matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    )) {
      compartidas.push(textos(si[1]));
    }
  }
  const libro = entradas.get('xl/workbook.xml');
  const nombres = libro
    ? [...leerEntrada(buf, libro).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(
        (m) => desescapar(m[1]),
      )
    : [];
  const hojas = [...entradas.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort(
      (a, b) =>
        Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]),
    );

  return hojas
    .map((hoja, i) => {
      const filas: string[][] = [];
      for (const fila of leerEntrada(buf, entradas.get(hoja)!).matchAll(
        /<row[^>]*>([\s\S]*?)<\/row>/g,
      )) {
        const celdas: string[] = [];
        for (const c of fila[1].matchAll(
          /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
        )) {
          const atributos = c[2] ?? '';
          const cuerpo = c[3] ?? '';
          const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
          let valor = '';
          if (atributos.includes('t="s"') && v !== undefined)
            valor = compartidas[Number(v)] ?? '';
          else if (atributos.includes('t="inlineStr"')) valor = textos(cuerpo);
          else if (v !== undefined) valor = desescapar(v);
          celdas[columna(c[1])] = valor;
        }
        filas.push(Array.from(celdas, (x) => x ?? ''));
      }
      const encabezado = filas[0] ?? [];
      const deFecha = encabezado.map((t) => /fecha|vence|emisi/i.test(t));
      const cuerpo = filas
        .slice(1)
        .map((f) =>
          f.map((x, j) =>
            deFecha[j] && /^\d{5}(\.\d+)?$/.test(x) ? fechaExcel(Number(x)) : x,
          ),
        );
      const tabla = [encabezado, ...cuerpo].map((f) => f.join('\t')).join('\n');
      return `### Hoja: ${nombres[i] ?? `Hoja ${i + 1}`}\n${tabla}`;
    })
    .join('\n\n');
}

// ── Word ────────────────────────────────────────────────────────────────

/** El texto de un .docx, un renglón por párrafo. */
export function textoDeDocx(buf: Buffer): string {
  const documento = entradasZip(buf).get('word/document.xml');
  if (!documento) throw new Error('No es un .docx');
  return [...leerEntrada(buf, documento).matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map((p) => textos(p[0]))
    .join('\n');
}
