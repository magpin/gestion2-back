/**
 * El remate de la glosa de un documento de contado: «· de contado en Caja
 * general», o «· de contado, repartida entre Caja general y Bancolombia
 * ···1234». A crédito —sin medios— no agrega nada.
 */
export function glosaContado(medios: string[]): string {
  if (medios.length === 0) return '';
  if (medios.length === 1) return ` · de contado en ${medios[0]}`;
  const lista = `${medios.slice(0, -1).join(', ')} y ${medios[medios.length - 1]}`;
  return ` · de contado, repartida entre ${lista}`;
}
