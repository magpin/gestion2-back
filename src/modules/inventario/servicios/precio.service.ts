import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CambiarPrecioDto, ListarPreciosDto } from '../dto/precio.dto';

export interface PrecioResumen {
  id: string;
  producto_id: string;
  precio_venta: string;
  nota: string | null;
  fecha_inicio: string;
  fecha_fin: string | null;
}

export interface PrecioBitacora extends PrecioResumen {
  producto_codigo: string;
  producto_nombre: string;
}

/**
 * El historial del precio de lista. Tabla histórica, mismo patrón que
 * `0005`: la fila vigente no se edita, se cierra con `fecha_fin` y se abre
 * una nueva. Este servicio es el único camino — nunca un `UPDATE` directo
 * sobre `precio_venta`.
 */
@Injectable()
export class PrecioService {
  constructor(private readonly tx: TxService) {}

  /**
   * Cierra la fila vigente e inserta la nueva, en una sola transacción. El
   * `UPDATE` toma el bloqueo de esa fila: dos cambios de precio simultáneos
   * sobre el mismo producto no fabrican dos vigentes — el segundo espera al
   * COMMIT del primero, y para entonces ya no hay fila que cerrar dos veces.
   */
  async cambiar(
    ctx: CtxEmpresa,
    productoId: string,
    dto: CambiarPrecioDto,
  ): Promise<PrecioResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      // Se mira antes de cerrar: el CHECK de la base rechazaría igual, pero
      // hablando de una "fecha de fin" que el usuario nunca escribió. Lo que
      // él eligió es el inicio del precio nuevo, y eso es lo que se le dice.
      const vigente = fila<{ fecha_inicio: string }>(
        await t.query(
          `SELECT to_char(fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio
             FROM producto_precio
            WHERE producto_id = $1 AND fecha_fin IS NULL
              FOR UPDATE`,
          [productoId],
        ),
      );
      if (vigente === undefined) {
        throw new NotFoundException(
          'El producto no tiene un precio vigente que cerrar.',
        );
      }
      if (dto.fechaInicio <= vigente.fecha_inicio) {
        throw new BadRequestException(
          `El precio vigente rige desde ${vigente.fecha_inicio}; el nuevo tiene que empezar después de esa fecha.`,
        );
      }

      const cerrado = fila<{ id: string }>(
        await t.query(
          `UPDATE producto_precio
              SET fecha_fin = ($2::date - INTERVAL '1 day')::date
            WHERE producto_id = $1 AND fecha_fin IS NULL
          RETURNING id`,
          [productoId, dto.fechaInicio],
        ),
      );
      if (cerrado === undefined) {
        throw new NotFoundException(
          'El producto no tiene un precio vigente que cerrar.',
        );
      }

      const creado = fila<PrecioResumen>(
        await t.query(
          `INSERT INTO producto_precio
             (empresa_id, producto_id, precio_venta, nota, fecha_inicio, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, producto_id, precio_venta, nota, fecha_inicio, fecha_fin`,
          [
            ctx.empresaId,
            productoId,
            dto.precioVenta,
            dto.nota ?? null,
            dto.fechaInicio,
            ctx.usuarioId,
          ],
        ),
      );
      if (creado === undefined) {
        throw new BadRequestException('No se pudo registrar el nuevo precio.');
      }
      return creado;
    });
  }

  /**
   * El precio de lista vigente de un producto, ahora mismo. `null` solo si
   * el producto no tiene ninguna fila —no debería pasar, `crear()` siempre
   * inserta una— pero se devuelve `null` y no se lanza: quien llama
   * (`InventarioApi.precioVigente`, para `ventas`) decide qué mensaje dar,
   * "sin precio configurado" dice más que un 404 genérico.
   */
  async vigenteDe(
    ctx: CtxEmpresa,
    productoId: string,
    tx?: Tx,
  ): Promise<number | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const vigente = fila<{ precio_venta: string }>(
          await t.query(
            `SELECT precio_venta FROM producto_precio
              WHERE producto_id = $1 AND fecha_fin IS NULL`,
            [productoId],
          ),
        );
        return vigente === undefined ? null : Number(vigente.precio_venta);
      },
      tx,
    );
  }

  /** El historial de UN producto, para su ficha. */
  async historialDe(
    ctx: CtxEmpresa,
    productoId: string,
  ): Promise<PrecioResumen[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<PrecioResumen>(
        await t.query(
          `SELECT id, producto_id, precio_venta, nota, fecha_inicio, fecha_fin
             FROM producto_precio
            WHERE producto_id = $1
            ORDER BY fecha_inicio DESC, creado_en DESC`,
          [productoId],
        ),
      ),
    );
  }

  /** La bitácora completa: todos los productos, todos los cambios. */
  async listarTodos(
    ctx: CtxEmpresa,
    p: ListarPreciosDto,
  ): Promise<Pagina<PrecioBitacora>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      if (p.desde !== undefined) {
        params.push(p.desde);
        condiciones.push(`pp.fecha_inicio >= $${params.length}`);
      }
      if (p.hasta !== undefined) {
        params.push(p.hasta);
        condiciones.push(`pp.fecha_inicio <= $${params.length}`);
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM producto_precio pp ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<PrecioBitacora>(
        await t.query(
          `SELECT pp.id, pp.producto_id, pp.precio_venta, pp.nota, pp.fecha_inicio, pp.fecha_fin,
                  pr.codigo AS producto_codigo, pr.nombre AS producto_nombre
             FROM producto_precio pp
             JOIN producto pr ON pr.id = pp.producto_id
             ${where}
            ORDER BY pp.fecha_inicio DESC, pp.creado_en DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }
}
