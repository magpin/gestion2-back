import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import type { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';

export interface FaltanteResumen {
  id: string;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  cantidad_faltante: string;
  costo_referencia: string;
  /** La factura que lo dejó en descubierto, para poder ir a verla. */
  venta_documento_id: string;
  documento: string;
  fecha: string;
  creado_en: string;
  /** Lo que hay hoy en el kardex de ese producto: negativo si sigue en rojo. */
  saldo_actual: string;
}

/**
 * Lo que se vendió sin tener: la lista de qué hay que comprar.
 *
 * `venta_faltante` la escribe `FacturaService` cuando alguien confirma una
 * factura en descubierto. Acá solo se lee, y se lee junto al saldo actual del
 * producto: un faltante de la semana pasada puede estar resuelto —la compra
 * entró— y lo que importa es cuáles siguen en rojo.
 *
 * No es una orden de compra: no numera, no tiene estado y nadie la "cierra".
 * Cuando exista ese documento, esta lista es de dónde sale.
 */
@Injectable()
export class FaltanteService {
  constructor(private readonly tx: TxService) {}

  async listar(
    ctx: CtxEmpresa,
    p: PaginacionDto,
    soloPendientes = false,
    tx?: Tx,
  ): Promise<Pagina<FaltanteResumen>> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        // El saldo del producto sale de su último movimiento: el mismo criterio
        // que el kardex (`secuencia DESC`, ver `0036`).
        const where = soloPendientes
          ? `WHERE (SELECT pm.saldo_cantidad FROM producto_movimiento pm
                     WHERE pm.producto_id = f.producto_id
                     ORDER BY pm.secuencia DESC LIMIT 1) < 0`
          : '';
        const datos = filas<FaltanteResumen>(
          await t.query(
            `SELECT f.id, f.producto_id, f.cantidad_faltante, f.costo_referencia,
                    f.venta_documento_id, f.creado_en,
                    p.codigo AS producto_codigo, p.nombre AS producto_nombre,
                    concat_ws('', d.prefijo, d.consecutivo::text) AS documento,
                    to_char(d.fecha, 'YYYY-MM-DD') AS fecha,
                    coalesce((SELECT pm.saldo_cantidad FROM producto_movimiento pm
                               WHERE pm.producto_id = f.producto_id
                               ORDER BY pm.secuencia DESC LIMIT 1), 0) AS saldo_actual
               FROM venta_faltante f
               JOIN producto p ON p.id = f.producto_id
               JOIN venta_documento d ON d.id = f.venta_documento_id
               ${where}
              ORDER BY f.creado_en DESC
              LIMIT $1 OFFSET $2`,
            [p.tamano, p.salto],
          ),
        );
        const total = filas<{ total: string }>(
          await t.query(
            `SELECT count(*)::text AS total FROM venta_faltante f ${where}`,
          ),
        );
        return armarPagina(datos, Number(total[0]?.total ?? 0), p);
      },
      tx,
    );
  }
}
