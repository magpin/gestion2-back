import { deflateRawSync } from 'zlib';

import { contenidoDe, textoDeDocx, textoDeXlsx } from './contenido';

/**
 * Un zip mínimo de verdad —entradas comprimidas, directorio central y fin—
 * para probar el lector con archivos reales y no con su propio espejo.
 */
function zip(archivos: Record<string, string>): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;
  for (const [nombre, texto] of Object.entries(archivos)) {
    const datos = deflateRawSync(Buffer.from(texto, 'utf8'));
    const n = Buffer.from(nombre, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locales.push(local, n, datos);
    centrales.push(central, n);
    offset += 30 + n.length + datos.length;
  }
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(archivos).length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, directorio, fin]);
}

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('contenidoDe', () => {
  it('PDF e imágenes van tal cual', () => {
    expect(
      contenidoDe({
        tipoMime: 'application/pdf',
        contenido: Buffer.from('%PDF'),
      }),
    ).toEqual({
      forma: 'document',
    });
    expect(
      contenidoDe({ tipoMime: 'image/png', contenido: Buffer.from('x') }),
    ).toEqual({
      forma: 'image',
    });
  });

  it('un Excel se vuelve tabla, con las cadenas compartidas y la fecha convertida', () => {
    const libro = zip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Compras" sheetId="1"/></sheets></workbook>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Fecha</t></si><si><t>Producto</t></si><si><t>Tinta &amp; cinta</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>46230</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>337812</v></c></row>' +
        '</sheetData></worksheet>',
    });

    const texto = textoDeXlsx(libro);

    expect(texto).toContain('### Hoja: Compras');
    expect(texto).toContain('Fecha\tProducto\tTotal');
    expect(texto).toContain('2026-07-27\tTinta & cinta\t337812');
    expect(contenidoDe({ tipoMime: XLSX, contenido: libro })).toMatchObject({
      forma: 'texto',
    });
  });

  it('un Word se vuelve texto, un renglón por párrafo', () => {
    const documento = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Contrato de arriendo</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Canon: </w:t></w:r><w:r><w:t>$1.500.000</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(textoDeDocx(documento)).toBe(
      'Contrato de arriendo\nCanon: $1.500.000',
    );
  });

  it('CSV, XML y lo que el navegador no supo nombrar, si es texto, se leen', () => {
    const csv = contenidoDe({
      tipoMime: 'text/csv',
      contenido: Buffer.from('a;b\n1;2'),
    });
    expect(csv).toEqual({
      forma: 'texto',
      texto: 'a;b\n1;2',
      recortado: false,
    });
    const raro = contenidoDe({
      tipoMime: 'application/octet-stream',
      contenido: Buffer.from('<Invoice>1</Invoice>'),
    });
    expect(raro).toMatchObject({ forma: 'texto' });
  });

  it('un binario que no se sabe abrir es null', () => {
    const xlsViejo = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]);
    expect(
      contenidoDe({
        tipoMime: 'application/vnd.ms-excel',
        contenido: xlsViejo,
      }),
    ).toBeNull();
    expect(
      contenidoDe({ tipoMime: XLSX, contenido: Buffer.from('no es zip') }),
    ).toBeNull();
  });

  it('un texto muy largo se recorta y lo dice', () => {
    const largo = contenidoDe({
      tipoMime: 'text/plain',
      contenido: Buffer.from('x'.repeat(200_000)),
    });
    expect(largo).toMatchObject({ forma: 'texto', recortado: true });
  });
});
