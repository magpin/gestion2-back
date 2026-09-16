import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearCajaDto, EditarCajaDto } from '../dto/caja.dto';

export interface Caja {
  id: string;
  nombre: string;
  tipo: 'PRINCIPAL' | 'MENOR';
  sede_id: string | null;
  cuenta_id: string;
  activa: boolean;
  /** Cuánta plata hay adentro hoy. `0` si la caja nunca se movió. */
  saldo: string;
  /** El día del último movimiento, o `null` si no hubo ninguno. */
  ultimo_movimiento: string | null;
}

/**
 * El saldo es el del último movimiento, no una suma: `CajaMovimientoService`
 * ya lleva el corrido y volver a sumarlo acá serían dos versiones de la misma
 * verdad. Ordena `secuencia` —dos movimientos del mismo día necesitan un orden
 * total— y para eso existe `ix_caja_movimiento_ultimo`.
 */
const ultimo = (columna: string, porDefecto: string) =>
  `(SELECT coalesce(
      (SELECT m.${columna} FROM caja_movimiento m
        WHERE m.caja_id = caja.id
        ORDER BY m.secuencia DESC
        LIMIT 1), ${porDefecto}))`;

const CAMPOS = `id, nombre, tipo, sede_id, cuenta_id, activa,
                ${ultimo('saldo_valor', '0')} AS saldo,
                ${ultimo('fecha', 'NULL')} AS ultimo_movimiento`;

/**
 * El maestro de cajas. Sin movimientos todavía —eso es `CajaMovimientoService`,
 * que necesita el candado de concurrencia y no comparte nada con el CRUD de
 * acá— mismo criterio que separa `ProductoService` de `KardexService`.
 */
@Injectable()
export class CajaService {
  constructor(private readonly tx: TxService) {}

  async crear(ctx: CtxEmpresa, dto: CrearCajaDto): Promise<Caja> {
    return this.tx.enContexto(ctx, async (t) => {
      const creada = fila<Caja>(
        await t.query(
          `INSERT INTO caja (empresa_id, nombre, tipo, sede_id, cuenta_id, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${CAMPOS}`,
          [
            ctx.empresaId,
            dto.nombre,
            dto.tipo,
            dto.sedeId ?? null,
            dto.cuentaId,
            ctx.usuarioId,
          ],
        ),
      );

      if (creada === undefined) {
        throw new BadRequestException('No se pudo crear la caja.');
      }
      return creada;
    });
  }

  async listar(
    ctx: CtxEmpresa,
    filtro: { incluirInactivas?: 'true' | 'false' } = {},
  ): Promise<Caja[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const where = filtro.incluirInactivas === 'true' ? '' : 'WHERE activa';
      return filas<Caja>(
        await t.query(
          `SELECT ${CAMPOS} FROM caja ${where} ORDER BY tipo, nombre`,
        ),
      );
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<Caja> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrada = fila<Caja>(
        await t.query(`SELECT ${CAMPOS} FROM caja WHERE id = $1`, [id]),
      );
      if (encontrada === undefined) {
        throw new NotFoundException('Caja no encontrada');
      }
      return encontrada;
    });
  }

  /**
   * Igual que `porId`, pero para consumo interno (`CajaMovimientoService`,
   * `TesoreriaApi`): devuelve `null` en vez de lanzar, y acepta `tx` para
   * engancharse a una transacción ajena — mismo criterio que
   * `ProductoService.buscar`.
   */
  async buscar(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<Caja | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const encontrada = fila<Caja>(
          await t.query(`SELECT ${CAMPOS} FROM caja WHERE id = $1`, [id]),
        );
        return encontrada ?? null;
      },
      tx,
    );
  }

  async editar(ctx: CtxEmpresa, id: string, dto: EditarCajaDto): Promise<Caja> {
    return this.tx.enContexto(ctx, async (t) => {
      const editada = fila<Caja>(
        await t.query(
          `UPDATE caja SET nombre = COALESCE($2, nombre)
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [id, dto.nombre ?? null],
        ),
      );
      if (editada === undefined) {
        throw new NotFoundException('Caja no encontrada');
      }
      return editada;
    });
  }

  /** No borra: desactiva. Una caja con movimientos no se puede quitar. */
  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE caja SET activa = false WHERE id = $1', [id]),
    );
  }

  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE caja SET activa = true WHERE id = $1', [id]),
    );
  }
}
