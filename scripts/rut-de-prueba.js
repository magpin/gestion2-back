// Arma un PDF de una pagina, sin dependencias, para `leer-documento.ts`.
//
//   node scripts/rut-de-prueba.js rut.pdf
//   npx ts-node scripts/leer-documento.ts rut.pdf RUT
//
// El contenido es un RUT INVENTADO, con los rotulos y las casillas del
// formulario 001 pero con datos que no son de nadie. Sirve para ejercitar la
// llamada —que la API acepte el esquema, que el caché pegue, que los campos
// vuelvan con su casilla—, no para probar que sabemos leer un RUT de verdad:
// eso necesita uno expedido por la DIAN, con su diagramacion y su escaneo.
//
// **No lleva representante legal, y es a proposito**: el formulario 001 no lo
// tiene. Las casillas 31 a 34 son los nombres del contribuyente y las 984 y 985
// son el funcionario que firma, «para uso exclusivo de la DIAN». La
// representacion vive en la hoja 2. Tampoco lleva una linea de «Regimen», por
// lo mismo: el regimen no es una casilla, se deriva de los codigos de la 53.
//
// Texto plano y una sola columna a proposito: si el modelo falla con esto, el
// problema no es el documento.
const fs = require('fs');

// La numeracion es la del formulario 001 de verdad, comprobada contra uno en
// la revision del paso 4. La version anterior de este archivo tenia la
// direccion en la 38, el municipio en la 42 y el correo en la 45, que son la
// 41, la 40 y la 42: con numeros inventados, comprobar que un campo vuelve con
// "su casilla" no comprueba nada.
const lineas = [
  'DOCUMENTO DE PRUEBA - DATOS FICTICIOS - NO ES UN DOCUMENTO OFICIAL',
  '',
  'Registro Unico Tributario - RUT',
  'Formulario 001',
  '',
  'Casilla 5  Numero de Identificacion Tributaria (NIT): 901234567',
  'Casilla 6  DV: 7',
  'Casilla 12 Direccion seccional: Impuestos de Medellin',
  '',
  'IDENTIFICACION',
  'Casilla 24 Tipo de contribuyente: Persona juridica',
  'Casilla 35 Razon social: SOLUCIONES CONTABLES DE PRUEBA S.A.S.',
  'Casilla 36 Nombre comercial: CONTAPRUEBA',
  'Casilla 37 Sigla: CONTAPRUEBA',
  '',
  'UBICACION',
  'Casilla 38 Pais: COLOMBIA',
  'Casilla 39 Departamento: ANTIOQUIA - codigo 05',
  'Casilla 40 Ciudad/Municipio: MEDELLIN - codigo 05001',
  'Casilla 41 Direccion principal: CALLE 10 No. 20-30 OFICINA 401',
  'Casilla 42 Correo electronico: contacto@contaprueba.test',
  'Casilla 43 Codigo postal: 050021',
  'Casilla 44 Telefono 1: 6045551234',
  'Casilla 45 Telefono 2:',
  '',
  'CLASIFICACION - Actividad economica',
  'Casilla 46 Codigo actividad principal: 6920',
  'Casilla 47 Fecha inicio actividad: 15/03/2020',
  'Casilla 48 Codigo actividad secundaria: 7020',
  'Casilla 49 Fecha inicio actividad: 15/03/2020',
  'Casilla 52 Numero establecimientos: 1',
  '',
  'Responsabilidades, Calidades y Atributos',
  'Casilla 53 Codigo: 05 - 07 - 09 - 14 - 48 - 52',
  '           05 - Impto. renta y compl. regimen ordinario',
  '           07 - Retencion en la fuente a titulo de renta',
  '           09 - Retencion en la fuente en el impuesto sobre las ventas',
  '           14 - Informante de exogena',
  '           48 - Impuesto sobre las ventas - IVA',
  '           52 - Facturador electronico',
  '',
  'Fecha de expedicion del documento: 04/02/2026',
];

const flujo =
  'BT\n/F1 11 Tf\n50 740 Td\n15 TL\n' +
  lineas.map((l) => '(' + l + ') Tj T*').join('\n') +
  '\nET';

const objetos = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Length ' +
    Buffer.byteLength(flujo, 'latin1') +
    ' >>\nstream\n' +
    flujo +
    '\nendstream',
];

let pdf = '%PDF-1.4\n';
const posiciones = [];
objetos.forEach((cuerpo, i) => {
  posiciones.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += i + 1 + ' 0 obj\n' + cuerpo + '\nendobj\n';
});

const inicioXref = Buffer.byteLength(pdf, 'latin1');
pdf += 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n';
for (const p of posiciones) {
  pdf += String(p).padStart(10, '0') + ' 00000 n \n';
}
pdf +=
  'trailer\n<< /Size ' +
  (objetos.length + 1) +
  ' /Root 1 0 R >>\nstartxref\n' +
  inicioXref +
  '\n%%EOF\n';

fs.writeFileSync(process.argv[2], Buffer.from(pdf, 'latin1'));
console.log('Escrito', process.argv[2], Buffer.byteLength(pdf, 'latin1'), 'bytes');
