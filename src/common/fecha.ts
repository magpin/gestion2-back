/**
 * El día de hoy como lo ve la empresa: `AAAA-MM-DD` en hora de Colombia.
 *
 * Un documento con fecha posterior a hoy no existe para la DIAN ni para el
 * libro, y el servidor puede estar en otra zona horaria —o en UTC—, donde a
 * las 7 de la noche de Bogotá ya es mañana. Por eso no se usa `new Date()` a
 * secas para comparar.
 */
export function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Rechaza con `mensaje` si `fecha` (AAAA-MM-DD) es posterior a hoy. */
export function esFechaFutura(fecha: string): boolean {
  return fecha > hoyEnColombia();
}

/**
 * Un documento fiscal de venta se emite el día que se emite: ni antes ni
 * después.
 *
 * Atrasarlo es meter un movimiento en un día que ya se cerró con la caja
 * cuadrada y el consecutivo corriendo; adelantarlo es facturar algo que
 * todavía no pasó. La compra es otra cosa —la factura del proveedor llega con
 * la fecha que él le puso, a veces días después— y conserva su propia regla.
 */
export function esDeHoy(fecha: string): boolean {
  return fecha === hoyEnColombia();
}

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * Una fecha `AAAA-MM-DD` como se lee en un documento: «28 de septiembre de
 * 2026».
 *
 * Se arma desde el texto y no con `Date`: una fecha sin hora pasada por `Date`
 * queda a la medianoche de alguna zona y, formateada en otra, sale el día
 * anterior. Si no tiene esa forma se devuelve tal cual.
 */
export function fechaEnLetras(fecha: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (partes === null) return fecha;
  const [, anio, mes, dia] = partes;
  const nombre = MESES[Number(mes) - 1];
  if (nombre === undefined) return fecha;
  return `${Number(dia)} de ${nombre} de ${anio}`;
}
