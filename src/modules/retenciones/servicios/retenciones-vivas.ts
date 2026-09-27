import { filas } from '../../../common/db/filas';
import type { Tx } from '../../../common/db/tx.service';

/** Una retención propia del documento, con lo que le queda viva. */
export interface RetencionViva {
  id: string;
  documento_tipo: string;
  tercero_id: string;
  concepto_nacional_id: string;
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
         SELECT p.id AS raiz, p.id, p.base, p.valor FROM propias p
         UNION ALL
         SELECT a.raiz, h.id, h.base, h.valor
           FROM arbol a JOIN retencion_calculada h ON h.anula_a = a.id
       )
       SELECT p.id, p.documento_tipo, p.tercero_id, p.concepto_nacional_id,
              n.usa_acumulado_anual, p.impuesto, p.municipio_codigo,
              p.fecha_causacion::text AS fecha_causacion, p.tarifa_nominal,
              p.factor_zomac, p.tarifa_efectiva, p.tarifa_id, p.uvt_valor,
              p.norma_aplicada, p.origen_clasificacion, p.es_autorretencion, p.estado,
              p.base AS base_original, p.valor AS valor_original,
              (SELECT sum(a.base) FROM arbol a WHERE a.raiz = p.id) AS base,
              (SELECT sum(a.valor) FROM arbol a WHERE a.raiz = p.id) AS valor
         FROM propias p
         JOIN retencion_concepto_nacional n ON n.id = p.concepto_nacional_id
        ORDER BY p.creado_en, p.id`,
      [documentoId],
    ),
  );
}
