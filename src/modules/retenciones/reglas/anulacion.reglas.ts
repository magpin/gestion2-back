/**
 * Cuánto se contrarresta de una retención cuando un documento se anula o
 * cuando una nota crédito devuelve parte de él. Sin base de datos (plan motor
 * de retenciones, §6.0; bugs 1 y 4 de la revisión del 27-09).
 *
 * Entra lo que `retencionesVivas` dice de cada retención propia del documento;
 * sale la fila que la contrarresta, o `null` si no hay nada que mover.
 */

/** Lo que hace falta de una retención viva para decidir. */
export interface RetencionParaReversar {
  /** Lo vivo: la fila más todo lo que cuelga de ella. */
  base: number;
  valor: number;
  /** Lo que puso el propio documento: la fila más sus ajustes por recálculo. */
  baseDocumento: number;
  valorDocumento: number;
  /** En una reversa de una nota: si la compra o la venta ya se anuló. */
  origenAnulado: boolean;
}

export interface Contrarresto {
  /** En positivo: la fila nueva va con el signo contrario. */
  base: number;
  valor: number;
}

const aCentavos = (n: number): number => Math.round(n * 100) / 100;

/**
 * Al anular: se contrarresta lo que le quede viva a la retención. En una
 * compra, lo suyo menos lo que devolvieron sus notas; en una nota, lo que la
 * nota había quitado, que vuelve.
 *
 * Salvo una cosa: si la nota corrige una compra (o venta) que ya se anuló,
 * no vuelve nada. La anulación de la compra ya dejó la retención en cero
 * contando lo que la nota había quitado; devolvérselo la revivía (bug 1).
 */
export function contrarrestoAlAnular(
  r: RetencionParaReversar,
): Contrarresto | null {
  if (r.origenAnulado || r.valor === 0) return null;
  return { base: r.base, valor: r.valor };
}

/**
 * La reversa de una nota crédito: la proporción devuelta de **lo que puso el
 * documento** —la retención original más sus ajustes por cambio de norma—,
 * al peso, y nunca más de lo que le queda viva.
 *
 * Antes se reversaba la original y cada ajuste por separado (un ajuste en
 * negativo se saltaba) y el asiento de la nota iba en centavos sobre la
 * original sola: la 2365 y el 350 no cuadraban (bug 4). Esta misma cifra la
 * usan el motor y el asiento de la nota.
 */
export function reversaProporcional(
  r: RetencionParaReversar,
  proporcion: number,
): Contrarresto | null {
  if (!(proporcion > 0)) return null;
  const valor = Math.min(Math.round(r.valorDocumento * proporcion), r.valor);
  if (valor <= 0) return null;
  const base = Math.max(
    0,
    Math.min(aCentavos(r.baseDocumento * proporcion), aCentavos(r.base)),
  );
  return { base, valor };
}
