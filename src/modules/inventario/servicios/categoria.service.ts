import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import type {
  CrearCategoriaDto,
  EditarCategoriaDto,
} from '../dto/categoria.dto';

export interface Categoria {
  id: string;
  nombre: string;
  activa: boolean;
  /** Cuántos productos tiene clasificados. Es lo que decide si se puede desactivar sin dejar huérfanos. */
  productos: string;
}

const CAMPOS = `id, nombre, activa,
                (SELECT count(*) FROM producto p WHERE p.categoria_id = producto_categoria.id)::text AS productos`;

/**
 * Las categorías del catálogo. Una lista, no un árbol: "Portátiles", "Cables",
 * "Tóner" — un nivel alcanza, y el día que no alcance se agrega `padre_id` sin
 * romper lo que ya esté clasificado.
 *
 * Sin paginar: una empresa tiene decenas de categorías, no miles. Mismo
 * criterio que `CajaService`.
 */
@Injectable()
export class CategoriaService {
  constructor(private readonly tx: TxService) {}

  async listar(
    ctx: CtxEmpresa,
    incluirInactivas = false,
  ): Promise<Categoria[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Categoria>(
        await t.query(
          `SELECT ${CAMPOS} FROM producto_categoria
            ${incluirInactivas ? '' : 'WHERE activa'}
            ORDER BY nombre`,
        ),
      ),
    );
  }

  async crear(ctx: CtxEmpresa, dto: CrearCategoriaDto): Promise<Categoria> {
    return this.tx.enContexto(ctx, async (t) => {
      const creada = fila<Categoria>(
        await t.query(
          `INSERT INTO producto_categoria (empresa_id, nombre, creado_por)
           VALUES ($1, $2, $3)
           RETURNING ${CAMPOS}`,
          [ctx.empresaId, dto.nombre.trim(), ctx.usuarioId],
        ),
      );
      if (creada === undefined) {
        throw new BadRequestException('No se pudo crear la categoría.');
      }
      return creada;
    });
  }

  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarCategoriaDto,
  ): Promise<Categoria> {
    return this.tx.enContexto(ctx, async (t) => {
      const editada = fila<Categoria>(
        await t.query(
          `UPDATE producto_categoria
              SET nombre = coalesce($2, nombre),
                  activa = coalesce($3, activa)
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [id, dto.nombre?.trim() ?? null, dto.activa ?? null],
        ),
      );
      if (editada === undefined) {
        throw new BadRequestException('Categoría no encontrada.');
      }
      return editada;
    });
  }
}
