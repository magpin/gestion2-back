/**
 * Una factura —de venta o de compra— con notas crédito o débito vivas no se
 * anula: primero se anulan las notas, una por una y cada una con su motivo.
 *
 * Anular la factura por debajo de sus notas dejaba cada nota corrigiendo un
 * documento que ya no existe, y al anularlas después revivían lo que la
 * factura ya había reversado —la retención, por ejemplo—. En Colombia la
 * factura electrónica validada no se anula: se corrige con nota, y cada
 * anulación es un acto explícito. Por eso el orden lo pone quien anula.
 */

/** Una nota que corrige a la factura y sigue viva. */
export interface NotaViva {
  tipo: string;
  numero: string;
}

function nombre(nota: NotaViva): string {
  const clase = nota.tipo === 'NOTA_DEBITO' ? 'nota débito' : 'nota crédito';
  return `la ${clase} ${nota.numero}`;
}

/**
 * El porqué del rechazo, nombrando las notas. `documento` es cómo se llama lo
 * que se quiso anular: «factura», «compra».
 */
export function mensajeNotasVivas(
  documento: string,
  notas: readonly NotaViva[],
): string {
  if (notas.length === 1) {
    return `Esta ${documento} tiene ${nombre(notas[0])} viva: anúlela primero.`;
  }
  const nombres = notas.map(nombre);
  const lista = `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
  return `Esta ${documento} tiene vivas ${lista}: anúlelas primero.`;
}
