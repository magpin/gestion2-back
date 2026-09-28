import { filas } from '../../../common/db/filas';
import type { Tx } from '../../../common/db/tx.service';
import type { RetencionParaReversar } from '../reglas/anulacion.reglas';

/** Una retención propia del documento, con lo que le queda viva. */
export interface RetencionViva {
  id: string;
  documento_tipo: string;
  tercero_id: string;
  concepto_nacional_id: string;
  /** El código de la ley: `HONORARIOS`, `RETEIVA_COMPRAS`… */
  concepto_codigo: string;
  usa_acumulado_anual: boolean;
  impuesto: string;
  municipio_codigo: string | null;
  fecha_causacion: string;
  tarifa_nominal: string;
  factor_zomac: string;
  tarifa_efectiva: string;
  tarifa_id: string | null;
  uvt_valor: string | null;
  norma_aplicada: string;
  origen_clasificacion: string;
  es_autorretencion: boolean;
  estado: string;
  base_original: string;
  valor_original: string;
  /** La fila más todo lo que cuelga de ella por `anula_a`, a cualquier nivel. */
  base: string;
  valor: string;
  /**
   * Lo que el propio documento puso en esta retención: la fila más sus
   * ajustes por cambio de norma (y su anulación, si la hubo), sin lo que
   * quitaron otros documentos. Sobre esto se saca la proporción de una nota.
   */
  base_documento: string;
  valor_documento: string;
  /**
   * Solo en una reversa hecha por otro documento (la de una nota crédito): si
   * el documento que originó la retención —la compra, la venta— ya se anuló.
   * Su anulación dejó todo en cero, y lo que la nota había quitado ya quedó
   * adentro de esa cuenta: anular la nota no lo devuelve (bug 1).
   */
  origen_anulado: boolean;
}

/**
 * Las retenciones **propias** de un documento y lo que le queda viva a cada una.
 *
 * Propias: las que el documento puso —las de una compra, o las reversas que
 * hizo una nota crédito—, no las que la anularon después. Lo vivo es la fila
 * más todo lo que cuelga de ella por `anula_a`, a cualquier nivel: la compra
 * menos lo que devolvieron sus notas, más lo que volvió cuando se anuló una
 * de esas notas. Así anular dos veces no reversa dos veces, y anular una nota
 * devuelve justo lo que la nota había quitado.
 *
 * `origen_anulado` mira la retención de arriba (la de la compra o la venta):
 * si entre lo que cuelga de ella hay una fila ANULADA del mismo documento de
 * arriba, ese documento se anuló.
 */
export async function retencionesVivas(
  t: Tx,
  documentoId: string,
): Promise<RetencionViva[]> {
  return filas<RetencionViva>(
    await t.query(
      `WITH RECURSIVE propias AS (
         SELECT rc.*
           FROM retencion_calculada rc
          WHERE rc.documento_id = $1
            AND NOT EXISTS (SELECT 1 FROM retencion_calculada p
                             WHERE p.id = rc.anula_a AND p.documento_id = $1)
       ), arbol AS (
         SELECT p.id AS raiz, p.id, p.base, p.valor, p.documento_id FROM propias p
         UNION ALL
         SELECT a.raiz, h.id, h.base, h.valor, h.documento_id
           FROM arbol a JOIN retencion_calculada h ON h.anula_a = a.id
       ), subida AS (
         -- De una reversa de otro documento hacia arriba, hasta la original.
         SELECT p.id AS propia, o.id, o.anula_a, o.documento_id
           FROM propias p JOIN retencion_calculada o ON o.id = p.anula_a
         UNION ALL
         SELECT s.propia, o.id, o.anula_a, o.documento_id
           FROM subida s JOIN retencion_calculada o ON o.id = s.anula_a
       ), bajada AS (
         -- Y de la original, todo lo que cuelga de ella.
         SELECT s.propia, s.documento_id AS documento_cima, s.id
           FROM subida s WHERE s.anula_a IS NULL
         UNION ALL
         SELECT b.propia, b.documento_cima, h.id
           FROM bajada b JOIN retencion_calculada h ON h.anula_a = b.id
       )
       SELECT p.id, p.documento_tipo, p.tercero_id, p.concepto_nacional_id,
              n.codigo AS concepto_codigo, n.usa_acumulado_anual, p.impuesto, p.municipio_codigo,
              p.fecha_causacion::text AS fecha_causacion, p.tarifa_nominal,
              p.factor_zomac, p.tarifa_efectiva, p.tarifa_id, p.uvt_valor,
              p.norma_aplicada, p.origen_clasificacion, p.es_autorretencion, p.estado,
              p.base AS base_original, p.valor AS valor_original,
              (SELECT sum(a.base) FROM arbol a WHERE a.raiz = p.id) AS base,
              (SELECT sum(a.valor) FROM arbol a WHERE a.raiz = p.id) AS valor,
              (SELECT sum(a.base) FROM arbol a
                WHERE a.raiz = p.id AND a.documento_id = p.documento_id) AS base_documento,
              (SELECT sum(a.valor) FROM arbol a
                WHERE a.raiz = p.id AND a.documento_id = p.documento_id) AS valor_documento,
              EXISTS (SELECT 1 FROM bajada b
                        JOIN retencion_calculada r ON r.id = b.id
                       WHERE b.propia = p.id
                         AND r.documento_id = b.documento_cima
                         AND r.estado = 'ANULADA') AS origen_anulado
         FROM propias p
         JOIN retencion_concepto_nacional n ON n.id = p.concepto_nacional_id
        ORDER BY p.creado_en, p.id`,
      [documentoId],
    ),
  );
}

/** Lo que las reglas de anulación y de nota crédito necesitan de una viva. */
export function paraReversar(v: RetencionViva): RetencionParaReversar {
  return {
    base: Number(v.base),
    valor: Number(v.valor),
    baseDocumento: Number(v.base_documento),
    valorDocumento: Number(v.valor_documento),
    origenAnulado: v.origen_anulado === true,
  };
}
