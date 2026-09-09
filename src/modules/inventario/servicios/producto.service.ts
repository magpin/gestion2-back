import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import {
  armarPagina,
  type Pagina,
  type PaginacionDto,
} from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearProductoDto, EditarProductoDto } from '../dto/producto.dto';

export interface ProductoResumen {
  id: string;
  codigo: string;
  nombre: string;
  unidad_medida: string;
  iva_tarifa: string;
  cuenta_inventario_id: string;
  /** Las dos siguientes: `null` en productos creados antes de que `ventas` exigiera este dato. */
  cuenta_costo_venta_id: string | null;
  cuenta_ingreso_id: string | null;
  activo: boolean;
}

const CAMPOS = `id, codigo, nombre, unidad_medida, iva_tarifa, cuenta_inventario_id,
                cuenta_costo_venta_id, cuenta_ingreso_id, activo`;

/**
 * El maestro de productos. Sin kardex todavía — eso es `KardexService`, que
 * necesita el candado de concurrencia y no comparte nada con el CRUD de acá.
 */
@Injectable()
export class ProductoService {
  constructor(private readonly tx: TxService) {}

  /**
   * Inserta el producto y su primer precio en una sola transacción: un
   * producto sin precio no tiene sentido, así que el precio inicial es
   * obligatorio y entra junto, no en un paso aparte. Si `cuentaInventarioId`
   * no existe o es de otra empresa, la FK compuesta de `producto` lo
   * rechaza — no hace falta validarlo a mano acá.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: CrearProductoDto,
  ): Promise<ProductoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const creado = fila<ProductoResumen>(
        await t.query(
          `INSERT INTO producto
             (empresa_id, codigo, nombre, unidad_medida, iva_tarifa, cuenta_inventario_id,
              cuenta_costo_venta_id, cuenta_ingreso_id, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${CAMPOS}`,
          [
            ctx.empresaId,
            dto.codigo,
            dto.nombre,
            dto.unidadMedida ?? 'UND',
            dto.ivaTarifa,
            dto.cuentaInventarioId,
            dto.cuentaCostoVentaId ?? null,
            dto.cuentaIngresoId ?? null,
            ctx.usuarioId,
          ],
        ),
      );

      if (creado === undefined) {
        throw new BadRequestException('No se pudo crear el producto.');
      }

      await t.query(
        `INSERT INTO producto_precio (empresa_id, producto_id, precio_venta, fecha_inicio, creado_por)
         VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
        [ctx.empresaId, creado.id, dto.precioVenta, ctx.usuarioId],
      );

      return creado;
    });
  }

  /** Búsqueda por código o nombre, sin tildes ni mayúsculas. */
  async listar(
    ctx: CtxEmpresa,
    p: PaginacionDto,
    filtro: {
      incluirInactivos?: 'true' | 'false';
      soloInactivos?: 'true' | 'false';
    },
  ): Promise<Pagina<ProductoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      if (filtro.soloInactivos === 'true') {
        condiciones.push('NOT activo');
      } else if (filtro.incluirInactivos !== 'true') {
        condiciones.push('activo');
      }
      if (p.q !== undefined && p.q.trim() !== '') {
        params.push(`%${p.q.trim()}%`);
        condiciones.push(
          `(codigo ILIKE $${params.length} OR fn_normalizar(nombre) LIKE fn_normalizar($${params.length}))`,
        );
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM producto ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<ProductoResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM producto
             ${where}
            ORDER BY codigo
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<ProductoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrado = fila<ProductoResumen>(
        await t.query(`SELECT ${CAMPOS} FROM producto WHERE id = $1`, [id]),
      );
      if (encontrado === undefined) {
        throw new NotFoundException('Producto no encontrado');
      }
      return encontrado;
    });
  }

  /**
   * Igual que `porId`, pero para consumo de otro módulo a través de
   * `InventarioApi`: devuelve `null` en vez de lanzar, y acepta `tx` para
   * engancharse a una transacción ajena — mismo criterio que
   * `NucleoApi.buscarTercero`. `porId` no cambia porque el controlador HTTP
   * sí necesita el 404.
   */
  async buscar(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<ProductoResumen | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const encontrado = fila<ProductoResumen>(
          await t.query(`SELECT ${CAMPOS} FROM producto WHERE id = $1`, [id]),
        );
        return encontrado ?? null;
      },
      tx,
    );
  }

  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarProductoDto,
  ): Promise<ProductoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const editado = fila<ProductoResumen>(
        await t.query(
          `UPDATE producto
              SET nombre = COALESCE($2, nombre),
                  unidad_medida = COALESCE($3, unidad_medida),
                  iva_tarifa = COALESCE($4, iva_tarifa),
                  cuenta_costo_venta_id = COALESCE($5, cuenta_costo_venta_id),
                  cuenta_ingreso_id = COALESCE($6, cuenta_ingreso_id)
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [
            id,
            dto.nombre ?? null,
            dto.unidadMedida ?? null,
            dto.ivaTarifa ?? null,
            dto.cuentaCostoVentaId ?? null,
            dto.cuentaIngresoId ?? null,
          ],
        ),
      );
      if (editado === undefined) {
        throw new NotFoundException('Producto no encontrado');
      }
      return editado;
    });
  }

  /** No borra: desactiva. Un producto con kardex no se puede quitar. */
  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE producto SET activo = false WHERE id = $1', [id]),
    );
  }

  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE producto SET activo = true WHERE id = $1', [id]),
    );
  }
}
