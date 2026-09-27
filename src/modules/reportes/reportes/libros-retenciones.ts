/**
 * Los reportes de retenciones en Excel — de filas a libro.
 *
 * Mismas reglas que `libros.ts`: una fila por movimiento, cifras como números,
 * fechas como fechas y totales con `SUBTOTAL`. Y **los números son los de la
 * hoja**: el 350 sale de `armar350`, no de otra suma.
 */
import type { Celda, Libro } from './libros';
import {
  armar350,
  armarCertificados,
  armarReteIca,
  tarifaTexto,
  type AsientoSuelto,
  type LibroDocumento,
  type Periodicidad,
  type Renglon350,
  type RetencionLeida,
} from './retenciones';

const aPesos = (centavos: number): number => centavos / 100;
const num = (texto: string): number => Number(texto);

/** El detalle, igual en los tres: lo que el contador filtra y cruza. */
function detalle(filas: RetencionLeida[]): Celda[][] {
  return filas.map((f) => [
    f.fecha,
    f.documento,
    f.tercero,
    f.terceroDocumento,
    f.tipoPersona === 'NATURAL' ? 'Natural' : 'Jurídica',
    f.impuesto,
    f.conceptoNombre + (f.esAutorretencion ? ' (autorretención)' : ''),
    f.municipioNombre,
    num(f.base),
    tarifaTexto(f.tarifa),
    num(f.valor),
    num(f.valor) < 0 ? 'Reversa' : '',
  ]);
}

const COLUMNAS_DETALLE: Libro['tablas'][number]['columnas'] = [
  { titulo: 'Fecha', tipo: 'FECHA', ancho: 12 },
  { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
  { titulo: 'Tercero', tipo: 'TEXTO', ancho: 34 },
  { titulo: 'NIT / documento', tipo: 'TEXTO', ancho: 16 },
  { titulo: 'Persona', tipo: 'TEXTO', ancho: 10 },
  { titulo: 'Impuesto', tipo: 'TEXTO', ancho: 9 },
  { titulo: 'Concepto', tipo: 'TEXTO', ancho: 34 },
  { titulo: 'Municipio', tipo: 'TEXTO', ancho: 16 },
  { titulo: 'Base', tipo: 'DINERO', ancho: 16, suma: true },
  { titulo: 'Tarifa', tipo: 'TEXTO', ancho: 9 },
  { titulo: 'Retenido', tipo: 'DINERO', ancho: 14, suma: true },
  { titulo: 'Tipo', tipo: 'TEXTO', ancho: 9 },
];

export function libro350(
  mes: { mes: string; etiqueta: string },
  filas: RetencionLeida[],
  renglones: Renglon350[],
  libro: { documentos: LibroDocumento[]; sueltos: AsientoSuelto[] },
): Libro {
  const f350 = armar350(mes.mes, filas, renglones, libro);
  const renglonesFilas: Celda[][] = f350.secciones.flatMap((s) =>
    s.renglones.map((r) => [
      s.titulo,
      r.nombre,
      r.casillas,
      r.pj === null ? null : aPesos(r.pj.baseMil),
      r.pj === null ? null : aPesos(r.pj.valorMil),
      r.pn === null ? null : aPesos(r.pn.baseMil),
      r.pn === null ? null : aPesos(r.pn.valorMil),
      r.unico === null ? null : aPesos(r.unico.baseMil),
      r.unico === null ? null : aPesos(r.unico.valorMil),
    ]),
  );
  return {
    titulo: 'Formulario 350 — retenciones del mes',
    parametros: [mes.etiqueta, 'Valores al múltiplo de mil (art. 577 ET)'],
    resumen: [
      {
        rotulo: 'Total retenciones de renta',
        valor: aPesos(f350.totales.centavos.renta),
        tipo: 'DINERO',
      },
      {
        rotulo: 'Total retenciones de IVA',
        valor: aPesos(f350.totales.centavos.iva),
        tipo: 'DINERO',
      },
      {
        rotulo: 'Total a declarar',
        valor: aPesos(f350.totales.centavos.total),
        tipo: 'DINERO',
      },
      {
        rotulo: 'Cuadra con el libro',
        valor: f350.cuadre.cuadra ? 'Sí' : `No: ${f350.cuadre.diferencia}`,
        tipo: 'TEXTO',
      },
    ],
    notas: [
      'Los renglones son una propuesta del sistema pendiente de validar por el contador (R-D15). Los números de casilla aparecen cuando se confirmen.',
      'Las notas crédito y las anulaciones van en el renglón «Menos: retenciones practicadas en exceso…», en el mes en que ocurrieron.',
      'La pestaña «Detalle» trae cada retención al peso; el formulario lleva cada renglón al múltiplo de mil.',
    ],
    tablas: [
      {
        nombre: 'Renglones',
        columnas: [
          { titulo: 'Sección', tipo: 'TEXTO', ancho: 26 },
          { titulo: 'Renglón', tipo: 'TEXTO', ancho: 48 },
          { titulo: 'Casillas', tipo: 'TEXTO', ancho: 12 },
          { titulo: 'Base P. jurídicas', tipo: 'DINERO', ancho: 16 },
          { titulo: 'Retención P. jurídicas', tipo: 'DINERO', ancho: 16 },
          { titulo: 'Base P. naturales', tipo: 'DINERO', ancho: 16 },
          { titulo: 'Retención P. naturales', tipo: 'DINERO', ancho: 16 },
          { titulo: 'Base', tipo: 'DINERO', ancho: 16 },
          { titulo: 'Valor', tipo: 'DINERO', ancho: 16 },
        ],
        filas: renglonesFilas,
        conTotales: false,
      },
      {
        nombre: 'Detalle',
        columnas: COLUMNAS_DETALLE,
        filas: detalle(filas.filter((f) => f.impuesto !== 'ICA')),
        conTotales: true,
      },
      {
        nombre: 'Cuadre con el libro',
        columnas: [
          { titulo: 'Documento', tipo: 'TEXTO', ancho: 18 },
          { titulo: 'Motor', tipo: 'DINERO', ancho: 14, suma: true },
          { titulo: 'Libro', tipo: 'DINERO', ancho: 14, suma: true },
          { titulo: 'Razón', tipo: 'TEXTO', ancho: 70 },
        ],
        filas: f350.cuadre.documentos.map((d) => [
          d.documento,
          aPesos(d.centavos.motor),
          aPesos(d.centavos.libro),
          d.razon,
        ]),
        conTotales: true,
      },
    ],
  };
}

export function libroReteIca(
  rango: { desde: string; hasta: string; etiqueta: string },
  filas: RetencionLeida[],
  periodicidades: Map<string, Periodicidad>,
): Libro {
  const r = armarReteIca(filas, periodicidades, rango);
  return {
    titulo: 'ReteICA por municipio',
    parametros: [rango.etiqueta],
    resumen: [
      {
        rotulo: 'Total retenido',
        valor: aPesos(r.totalCentavos),
        tipo: 'DINERO',
      },
      { rotulo: 'Municipios', valor: r.municipios.length, tipo: 'ENTERO' },
    ],
    notas: r.municipios
      .filter((m) => m.aviso !== null)
      .map((m) => `${m.nombre}: ${m.aviso}`),
    tablas: [
      {
        nombre: 'Por municipio y tercero',
        columnas: [
          { titulo: 'Municipio', tipo: 'TEXTO', ancho: 20 },
          { titulo: 'Tercero', tipo: 'TEXTO', ancho: 34 },
          { titulo: 'NIT / documento', tipo: 'TEXTO', ancho: 16 },
          { titulo: 'Base', tipo: 'DINERO', ancho: 16, suma: true },
          { titulo: 'Tarifas', tipo: 'TEXTO', ancho: 14 },
          { titulo: 'Retenido', tipo: 'DINERO', ancho: 14, suma: true },
        ],
        filas: r.municipios.flatMap((m) =>
          m.terceros.map((t) => [
            m.nombre,
            t.tercero,
            t.terceroDocumento,
            aPesos(t.centavos.base),
            t.tarifas,
            aPesos(t.centavos.retenido),
          ]),
        ),
        conTotales: true,
      },
      {
        nombre: 'Detalle',
        columnas: COLUMNAS_DETALLE,
        filas: detalle(filas.filter((f) => f.impuesto === 'ICA')),
        conTotales: true,
      },
    ],
  };
}

export function libroCertificados(
  rango: { desde: string; hasta: string; etiqueta: string },
  filas: RetencionLeida[],
): Libro {
  const c = armarCertificados(filas);
  return {
    titulo: 'Certificados de retención',
    parametros: [rango.etiqueta],
    resumen: [
      {
        rotulo: 'Terceros con certificado',
        valor: c.certificados.length,
        tipo: 'ENTERO',
      },
      {
        rotulo: 'Total retenido',
        valor: aPesos(c.totalCentavos),
        tipo: 'DINERO',
      },
    ],
    notas: [
      'Neto de notas crédito y anulaciones. Las autorretenciones no van: no se practicaron a un tercero.',
    ],
    tablas: [
      {
        nombre: 'Por tercero',
        columnas: [
          { titulo: 'Tercero', tipo: 'TEXTO', ancho: 34 },
          { titulo: 'NIT / documento', tipo: 'TEXTO', ancho: 16 },
          { titulo: 'Impuesto', tipo: 'TEXTO', ancho: 9 },
          { titulo: 'Concepto o municipio', tipo: 'TEXTO', ancho: 34 },
          { titulo: 'Base', tipo: 'DINERO', ancho: 16, suma: true },
          { titulo: 'Retenido', tipo: 'DINERO', ancho: 14, suma: true },
        ],
        filas: c.certificados.flatMap((t) => [
          ...t.renta.map((r) => [
            t.tercero,
            t.terceroDocumento,
            'RENTA',
            r.concepto,
            aPesos(r.centavos.base),
            aPesos(r.centavos.retenido),
          ]),
          ...(t.iva === null
            ? []
            : [
                [
                  t.tercero,
                  t.terceroDocumento,
                  'IVA',
                  'Retención de IVA',
                  aPesos(t.iva.centavos.base),
                  aPesos(t.iva.centavos.retenido),
                ],
              ]),
          ...t.ica.map((r) => [
            t.tercero,
            t.terceroDocumento,
            'ICA',
            r.municipio,
            aPesos(r.centavos.base),
            aPesos(r.centavos.retenido),
          ]),
        ]),
        conTotales: true,
      },
    ],
  };
}
