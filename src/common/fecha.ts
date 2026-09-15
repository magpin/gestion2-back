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
