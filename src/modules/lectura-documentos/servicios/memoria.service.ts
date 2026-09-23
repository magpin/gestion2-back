import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { Aprendizaje } from '../reglas/memoria.reglas';

/**
 * Lo que María recuerda de una factura a la siguiente: la tabla
 * `renglon_aprendido` (migración 0063).
 *
 * Solo busca y escribe. **Qué** se aprende y cuándo lo recordado sirve lo
 * deciden `reglas/memoria.reglas.ts`, sin base de datos y con sus pruebas.
 */

/** Lo que se recuerda de un renglón, tal como quedó guardado. */
export interface Recordado {
  clase: 'PRODUCTO' | 'GASTO';
  texto: string;
  productoId: string | null;
  cuentaId: string | null;
  /** El número de la factura en que una persona lo contestó. */
  numeroFactura: string;
}

interface FilaRecordado {
  clase: 'PRODUCTO' | 'GASTO';
  texto: string;
  producto_id: string | null;
  cuenta_id: string | null;
  numero_factura: string;
}

@Injectable()
export class MemoriaService {
  constructor(private readonly tx: TxService) {}

  /**
   * Lo recordado de un proveedor para estos textos. La llave de cada uno es
   * `clase|texto`, que es como la arma quien pregunta.
   */
  async recordados(
    ctx: CtxEmpresa,
    terceroId: string,
    llaves: Array<{ clase: 'PRODUCTO' | 'GASTO'; texto: string }>,
  ): Promise<Map<string, Recordado>> {
    if (llaves.length === 0) return new Map();

    return this.tx.enContexto(ctx, async (t) => {
      const encontrados = filas<FilaRecordado>(
        await t.query(
          `SELECT r.clase, r.texto, r.producto_id, r.cuenta_id,
                  c.numero_factura_proveedor AS numero_factura
             FROM renglon_aprendido r
             JOIN compra_documento c ON c.id = r.compra_documento_id
            WHERE r.tercero_id = $1
              AND (r.clase, r.texto) IN (
                SELECT * FROM unnest($2::text[], $3::text[])
              )`,
          [terceroId, llaves.map((l) => l.clase), llaves.map((l) => l.texto)],
        ),
      );

      return new Map(
        encontrados.map((f) => [
          `${f.clase}|${f.texto}`,
          {
            clase: f.clase,
            texto: f.texto,
            productoId: f.producto_id,
            cuentaId: f.cuenta_id,
            numeroFactura: f.numero_factura,
          },
        ]),
      );
    });
  }

  /**
   * Guarda lo aprendido **en la transacción de la compra**: si la compra no
   * entra, no se aprende nada. Por eso exige el `tx` y no abre uno propio.
   */
  async aprender(
    ctx: CtxEmpresa,
    terceroId: string,
    compraId: string,
    aprendizajes: Aprendizaje[],
    t: Tx,
  ): Promise<void> {
    for (const a of aprendizajes) {
      if (a.tipo === 'USO') {
        await t.query(
          `UPDATE renglon_aprendido
              SET veces_usado = veces_usado + 1, usado_en = now()
            WHERE tercero_id = $1 AND clase = $2 AND texto = $3`,
          [terceroId, a.clase, a.texto],
        );
        continue;
      }

      // Si la respuesta es la misma que ya había, es un uso más; si es otra,
      // reemplaza a la anterior y la cuenta vuelve a empezar.
      await t.query(
        `INSERT INTO renglon_aprendido
           (empresa_id, tercero_id, clase, texto, ejemplo,
            producto_id, cuenta_id, aprendido_por, compra_documento_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (empresa_id, tercero_id, clase, texto) DO UPDATE SET
           veces_usado = CASE
             WHEN renglon_aprendido.producto_id IS NOT DISTINCT FROM EXCLUDED.producto_id
              AND renglon_aprendido.cuenta_id   IS NOT DISTINCT FROM EXCLUDED.cuenta_id
             THEN renglon_aprendido.veces_usado + 1
             ELSE 1
           END,
           producto_id         = EXCLUDED.producto_id,
           cuenta_id           = EXCLUDED.cuenta_id,
           ejemplo             = EXCLUDED.ejemplo,
           aprendido_por       = EXCLUDED.aprendido_por,
           compra_documento_id = EXCLUDED.compra_documento_id,
           usado_en            = now()`,
        [
          ctx.empresaId,
          terceroId,
          a.clase,
          a.texto,
          a.ejemplo,
          a.productoId ?? null,
          a.cuentaId ?? null,
          ctx.usuarioId,
          compraId,
        ],
      );
    }
  }
}
