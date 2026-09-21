// Arma un PDF de una pagina, sin dependencias, para `leer-documento.ts`.
//
//   node scripts/rut-de-prueba.js rut.pdf
//   npx ts-node scripts/leer-documento.ts rut.pdf RUT
//
// El contenido es un RUT INVENTADO, con los rotulos y las casillas del
// formulario 001 pero con datos que no son de nadie. Sirve para ejercitar la
// llamada —que la API acepte el esquema, que el caché pegue, que los campos
// vuelvan con su casilla—, no para probar que sabemos leer un RUT de verdad:
// eso necesita uno expedido por la DIAN, con su diagramacion y su escaneo, y es
// lo que pide el paso 4 del cierre.
//
// Texto plano y una sola columna a proposito: si el modelo falla con esto, el
// problema no es el documento.
const fs = require('fs');

const lineas = [
  'DOCUMENTO DE PRUEBA - DATOS FICTICIOS - NO ES UN DOCUMENTO OFICIAL',
  '',
  'Registro Unico Tributario - RUT',
  'Formulario 001',
  '',
  'Casilla 5  Numero de Identificacion Tributaria NIT: 900123456',
  'Casilla 6  DV: 7',
  'Casilla 12 Direccion seccional: Impuestos de Medellin',
  '',
  'Casilla 35 Razon social: SOLUCIONES CONTABLES DE PRUEBA S.A.S.',
  'Casilla 36 Nombre comercial: CONTAPRUEBA',
  '',
  'Casilla 38 Direccion principal: CALLE 10 No. 20-30 OFICINA 401',
  'Casilla 40 Pais: COLOMBIA',
  'Casilla 41 Departamento: ANTIOQUIA - codigo 05',
  'Casilla 42 Municipio: MEDELLIN - codigo 05001',
  'Casilla 44 Telefono 1: 6045551234',
  'Casilla 45 Correo electronico: contacto@contaprueba.test',
  '',
  'Casilla 46 Actividad economica principal',
  '           Codigo CIIU: 6920   Fecha inicio: 15/03/2020',
  'Casilla 48 Actividad secundaria - Codigo CIIU: 7020',
  '',
  'Casilla 53 Responsabilidades, calidades y atributos:',
  '           05 - 07 - 09 - 14 - 48 - 52',
  '',
  'Regimen: Responsable del impuesto sobre las ventas - IVA',
  '',
  'Representante legal',
  '           Nombre: MARIA FERNANDA GOMEZ RESTREPO',
  '           Tipo de documento: Cedula de ciudadania',
  '           Numero de documento: 43123456',
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
