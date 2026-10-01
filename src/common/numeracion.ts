import type { Tx } from './db/tx.service';
import { fila } from './db/filas';

/** El siguiente número de una resolución, sin tomarlo. */
export interface Numeracion {
  siguiente: string;
  resolucion: string;
  desde: number;
  hasta: number;
  quedan: number;
}

/**
 * Qué número sale si se emite ahora, de la resolución activa de ese tipo
 * (`FACTURA_VENTA`, `DOCUMENTO_SOPORTE`), y cuántos quedan. `null` si no hay
 * resolución. Solo lee: el número se toma al emitir, en la misma transacción.
 */
export async function numeracionDe(
  t: Tx,
  tipoDocumento: string,
): Promise<Numeracion | null> {
  const r = fila<{
    prefijo: string | null;
    numero_resolucion: string;
    rango_desde: string;
    rango_hasta: string;
    consecutivo_actual: string;
  }>(
    await t.query(
      `SELECT prefijo, numero_resolucion, rango_desde, rango_hasta, consecutivo_actual
         FROM empresa_resolucion_dian
        WHERE tipo_documento = $1 AND activa
        LIMIT 1`,
      [tipoDocumento],
    ),
  );
  if (r === undefined) return null;
  const siguiente = Number(r.consecutivo_actual) + 1;
  return {
    siguiente: `${r.prefijo ?? ''}${siguiente}`,
    resolucion: r.numero_resolucion,
    desde: Number(r.rango_desde),
    hasta: Number(r.rango_hasta),
    quedan: Math.max(0, Number(r.rango_hasta) - Number(r.consecutivo_actual)),
  };
}
