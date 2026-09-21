/**
 * Los reportes en Excel — de filas a libro.
 *
 * Puro, como los de la hoja: entran las mismas facturas que lee el PDF y sale
 * la **descripción** del libro —hojas, columnas, filas—. Escribir el `.xlsx`
 * es de `ExcelService`; decidir qué va adentro es de acá, y por eso se prueba
 * sin ExcelJS ni base.
 *
 * El Excel no es el PDF en otra extensión. **Es lo que un contador hace de
 * verdad con los datos**: filtrar, ordenar, armar su tabla dinámica. Por eso:
 *
 * - Una fila por factura, sin agrupar: agrupar lo hace él, como quiera.
 * - Las cifras son **números**, no texto con «$»: un «$ 68.575.000» escrito no
 *   se suma. El formato de pesos va aparte, en la columna.
 * - Las fechas son fechas, para que filtrar por mes funcione.
 * - Los totales son fórmulas `SUBTOTAL`: al filtrar, suman lo que se ve.
 *
 * **Los números son los del PDF**: salen de las mismas facturas con las mismas
 * reglas —`situacionDe`, `tramoDe`, el mismo plazo—. Un Excel que no cuadra con
 * la hoja firmada es peor que no tener Excel.
 */
import { TRAMOS, tramoDe } from './antiguedad-cartera';
import {
  aCentavos,
  DIAS_PARA_VENCER,
  dias,
  situacionDe,
  type FacturaLeida,
} from './ventas-por-cliente';

export type TipoColumna = 'TEXTO' | 'FECHA' | 'DINERO' | 'ENTERO' | 'PORCIENTO';

export interface Columna {
  titulo: string;
  tipo: TipoColumna;
  /** Ancho en caracteres, como lo mide Excel. */
  ancho: number;
  /** Si la fila de totales la suma. Solo tiene sentido en cifras. */
  suma?: boolean;
}

/** Una celda: texto, número (pesos, no centavos), fecha `aaaa-mm-dd` o nada. */
export type Celda = string | number | null;

export interface Tabla {
  /** El nombre de la pestaña. Excel no acepta más de 31 caracteres. */
  nombre: string;
  columnas: Columna[];
  filas: Celda[][];
  /** Si lleva una fila de totales al pie. */
  conTotales: boolean;
}

export interface Libro {
  titulo: string;
  /** Con qué se corrió, en palabras. Va arriba de la hoja «Resumen». */
  parametros: string[];
  /** Las cifras de arriba del PDF, como pares rótulo–valor. */
  resumen: { rotulo: string; valor: Celda; tipo: TipoColumna }[];
  /** Lo que el lector tiene que saber para no leer mal los números. */
  notas: string[];
  tablas: Tabla[];
}

/** Centavos a pesos: Excel guarda el número, el formato pone los puntos. */
const aPesos = (centavos: number): number => centavos / 100;

const saldoDe = (f: FacturaLeida): number =>
  Math.max(0, aCentavos(f.total) - aCentavos(f.pagado));

/* ── Ventas del mes por cliente ─────────────────────────────────────────── */

export function libroVentas(
  facturas: FacturaLeida[],
  rango: { desde: string; hasta: string; etiqueta: string },
): Libro {
  // Las anuladas van en su propia pestaña. En «Facturas» se sumarían con el
  // `SUBTOTAL` y el total dejaría de cuadrar con el del PDF, que no las cuenta.
  const validas = facturas.filter((f) => f.estado !== 'ANULADA');
  const anuladas = facturas.filter((f) => f.estado === 'ANULADA');

  let total = 0;
  let cobrado = 0;
  let porCobrar = 0;
  let vencido = 0;
  const porCliente = new Map<
    string,
    {
      documento: string;
      facturas: number;
      total: number;
      cobrado: number;
      porCobrar: number;
      vencido: number;
    }
  >();

  const filasFacturas: Celda[][] = validas.map((f) => {
    const t = aCentavos(f.total);
    const saldo = saldoDe(f);
    const desdeEmision = dias(f.fecha, rango.hasta);
    const { situacion, etiqueta } = situacionDe(f, saldo, desdeEmision);

    total += t;
    cobrado += t - saldo;
    porCobrar += saldo;
    if (situacion === 'VENCIDA') vencido += saldo;

    const c = porCliente.get(f.cliente) ?? {
      documento: f.clienteDocumento,
      facturas: 0,
      total: 0,
      cobrado: 0,
      porCobrar: 0,
      vencido: 0,
    };
    c.facturas += 1;
    c.total += t;
    c.cobrado += t - saldo;
    c.porCobrar += saldo;
    if (situacion === 'VENCIDA') c.vencido += saldo;
    porCliente.set(f.cliente, c);

    return [
      f.cliente,
      f.clienteDocumento,
      f.numero,
      f.fecha,
      desdeEmision,
      etiqueta,
      aPesos(t),
      aPesos(t - saldo),
      aPesos(saldo),
    ];
  });

  const filasClientes: Celda[][] = [...porCliente.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([cliente, c]) => [
      cliente,
      c.documento,
      c.facturas,
      aPesos(c.total),
      aPesos(c.cobrado),
      aPesos(c.porCobrar),
      aPesos(c.vencido),
      total === 0 ? 0 : c.total / total,
    ]);

  const tablas: Tabla[] = [
    {
      nombre: 'Facturas',
      columnas: [
        { titulo: 'Cliente', tipo: 'TEXTO', ancho: 32 },
        { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
        { titulo: 'Factura', tipo: 'TEXTO', ancho: 14 },
        { titulo: 'Fecha', tipo: 'FECHA', ancho: 12 },
        { titulo: 'Días desde emisión', tipo: 'ENTERO', ancho: 12 },
        { titulo: 'Situación', tipo: 'TEXTO', ancho: 12 },
        { titulo: 'Total', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Cobrado', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Por cobrar', tipo: 'DINERO', ancho: 16, suma: true },
      ],
      filas: filasFacturas,
      conTotales: true,
    },
    {
      nombre: 'Por cliente',
      columnas: [
        { titulo: 'Cliente', tipo: 'TEXTO', ancho: 32 },
        { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
        { titulo: 'Facturas', tipo: 'ENTERO', ancho: 10, suma: true },
        { titulo: 'Total', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Cobrado', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Por cobrar', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Vencido', tipo: 'DINERO', ancho: 16, suma: true },
        { titulo: 'Participación', tipo: 'PORCIENTO', ancho: 13 },
      ],
      filas: filasClientes,
      conTotales: true,
    },
  ];

  if (anuladas.length > 0) {
    tablas.push({
      nombre: 'Anuladas',
      columnas: [
        { titulo: 'Cliente', tipo: 'TEXTO', ancho: 32 },
        { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
        { titulo: 'Factura', tipo: 'TEXTO', ancho: 14 },
        { titulo: 'Fecha', tipo: 'FECHA', ancho: 12 },
        { titulo: 'Total que tenía', tipo: 'DINERO', ancho: 16 },
      ],
      filas: anuladas.map((f) => [
        f.cliente,
        f.clienteDocumento,
        f.numero,
        f.fecha,
        aPesos(aCentavos(f.total)),
      ]),
      conTotales: false,
    });
  }

  return {
    titulo: 'Ventas del mes por cliente',
    parametros: [`Del ${rango.desde} al ${rango.hasta} · ${rango.etiqueta}`],
    resumen: [
      { rotulo: 'Total facturado', valor: aPesos(total), tipo: 'DINERO' },
      { rotulo: 'Cobrado', valor: aPesos(cobrado), tipo: 'DINERO' },
      { rotulo: 'Por cobrar', valor: aPesos(porCobrar), tipo: 'DINERO' },
      { rotulo: 'Vencido', valor: aPesos(vencido), tipo: 'DINERO' },
      { rotulo: 'Facturas', valor: validas.length, tipo: 'ENTERO' },
      { rotulo: 'Clientes', valor: porCliente.size, tipo: 'ENTERO' },
    ],
    notas: [
      `«Vencida» es una factura con saldo y más de ${DIAS_PARA_VENCER} días desde su emisión: el sistema no guarda la fecha de vencimiento pactada.`,
      'Los días se cuentan hasta el último día del rango.',
      ...(anuladas.length > 0
        ? ['Las facturas anuladas no suman: están en la pestaña «Anuladas».']
        : []),
    ],
    tablas,
  };
}

/* ── Antigüedad de saldos de cartera ─────────────────────────────────────── */

export function libroCartera(
  facturas: FacturaLeida[],
  corte: { corte: string; etiqueta: string },
  plazo: number,
): Libro {
  const totales = new Map<string, number>(TRAMOS.map((t) => [t.clave, 0]));
  const porCliente = new Map<
    string,
    { documento: string; tramos: Map<string, number> }
  >();
  let total = 0;

  const filasFacturas: Celda[][] = [];
  for (const f of facturas) {
    // Lo mismo que la hoja: una anulada o una pagada no deben nada.
    if (f.estado === 'ANULADA') continue;
    const saldo = saldoDe(f);
    if (saldo === 0) continue;

    const desdeEmision = dias(f.fecha, corte.corte);
    const vencidos = desdeEmision - plazo;
    const clave = tramoDe(vencidos);
    const tramo = TRAMOS.find((t) => t.clave === clave);

    total += saldo;
    totales.set(clave, (totales.get(clave) ?? 0) + saldo);
    const c = porCliente.get(f.cliente) ?? {
      documento: f.clienteDocumento,
      tramos: new Map(),
    };
    c.tramos.set(clave, (c.tramos.get(clave) ?? 0) + saldo);
    porCliente.set(f.cliente, c);

    filasFacturas.push([
      f.cliente,
      f.clienteDocumento,
      f.numero,
      f.fecha,
      desdeEmision,
      Math.max(0, vencidos),
      tramo?.etiqueta ?? '',
      aPesos(saldo),
    ]);
  }

  const filasClientes: Celda[][] = [...porCliente.entries()]
    .map(([cliente, c]) => {
      const suyo = [...c.tramos.values()].reduce((a, b) => a + b, 0);
      return { cliente, c, suyo };
    })
    .sort((a, b) => b.suyo - a.suyo)
    .map(({ cliente, c, suyo }) => [
      cliente,
      c.documento,
      ...TRAMOS.map((t) => aPesos(c.tramos.get(t.clave) ?? 0)),
      aPesos(suyo),
    ]);

  // «Más de 90» a secas se lee como una cantidad, no como un tramo.
  const rotulo = (etiqueta: string) =>
    etiqueta === 'Sin vencer' || etiqueta.endsWith('días')
      ? etiqueta
      : `${etiqueta} días`;

  return {
    titulo: 'Antigüedad de saldos de cartera',
    parametros: [`Corte al ${corte.corte} · ${corte.etiqueta}`],
    resumen: [
      { rotulo: 'Cartera total', valor: aPesos(total), tipo: 'DINERO' },
      ...TRAMOS.map((t) => ({
        rotulo: rotulo(t.etiqueta),
        valor: aPesos(totales.get(t.clave) ?? 0),
        tipo: 'DINERO' as const,
      })),
      { rotulo: 'Clientes con saldo', valor: porCliente.size, tipo: 'ENTERO' },
    ],
    notas: [
      `Los días vencidos son los días desde la emisión menos ${plazo} de plazo: el sistema no guarda el plazo pactado con cada cliente.`,
      'Solo entran facturas con saldo mayor a $ 0 a la fecha de corte.',
    ],
    tablas: [
      {
        nombre: 'Por cliente',
        columnas: [
          { titulo: 'Cliente', tipo: 'TEXTO', ancho: 32 },
          { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
          ...TRAMOS.map((t) => ({
            titulo: rotulo(t.etiqueta),
            tipo: 'DINERO' as const,
            ancho: 15,
            suma: true,
          })),
          { titulo: 'Total', tipo: 'DINERO', ancho: 16, suma: true },
        ],
        filas: filasClientes,
        conTotales: true,
      },
      {
        nombre: 'Facturas',
        columnas: [
          { titulo: 'Cliente', tipo: 'TEXTO', ancho: 32 },
          { titulo: 'Documento', tipo: 'TEXTO', ancho: 16 },
          { titulo: 'Factura', tipo: 'TEXTO', ancho: 14 },
          { titulo: 'Fecha', tipo: 'FECHA', ancho: 12 },
          { titulo: 'Días desde emisión', tipo: 'ENTERO', ancho: 12 },
          { titulo: 'Días vencida', tipo: 'ENTERO', ancho: 11 },
          { titulo: 'Tramo', tipo: 'TEXTO', ancho: 15 },
          { titulo: 'Saldo', tipo: 'DINERO', ancho: 16, suma: true },
        ],
        filas: filasFacturas,
        conTotales: true,
      },
    ],
  };
}
