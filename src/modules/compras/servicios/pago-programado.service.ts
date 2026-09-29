import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';

export interface PagoProgramado {
  id: string;
  descripcion: string;
  terceroId: string | null;
  terceroNombre: string | null;
  compraId: string | null;
  conceptoId: string | null;
  conceptoNombre: string | null;
  valor: number;
  fecha: string;
  recurrencia: 'UNA_VEZ' | 'MENSUAL';
  estado: 'PENDIENTE' | 'PAGADO' | 'CANCELADO';
}

const CAMPOS = `
  p.id, p.descripcion, p.tercero_id, p.compra_id, p.concepto_id, p.valor, p.fecha,
  p.recurrencia, p.estado,
  (SELECT COALESCE(t.razon_social, concat_ws(' ', t.primer_nombre, t.primer_apellido))
     FROM tercero t WHERE t.id = p.tercero_id) AS tercero_nombre,
  (SELECT c.nombre FROM concepto_movimiento c WHERE c.id = p.concepto_id) AS concepto_nombre`;

/** El mismo día del mes siguiente; si no existe (31 → febrero), el último del mes. */
export function mesSiguiente(fecha: string): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  const destino = new Date(Date.UTC(a, m, Math.min(d, ultimo)));
  return destino.toISOString().slice(0, 10);
}

/**
 * Lo que hay que pagar y cuándo: una compra que vence, el arriendo de cada
 * mes. No mueve plata —eso lo hace el comprobante de egreso o el pago sin
 * factura—: es la agenda de lo que sale, y lo que alimenta «esta semana sale».
 * Uno mensual, al marcarse pagado, deja programado el del mes siguiente.
 */
@Injectable()
export class PagoProgramadoService {
  constructor(private readonly tx: TxService) {}

  async listar(
    ctx: CtxEmpresa,
    soloPendientes = true,
  ): Promise<PagoProgramado[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT ${CAMPOS} FROM pago_programado p
            ${soloPendientes ? "WHERE p.estado = 'PENDIENTE'" : ''}
            ORDER BY p.fecha LIMIT 300`,
        ),
      ).map(aProgramado),
    );
  }

  async crear(
    ctx: CtxEmpresa,
    datos: {
      descripcion: string;
      terceroId?: string;
      compraId?: string;
      conceptoId?: string;
      valor: number;
      fecha: string;
      recurrencia: 'UNA_VEZ' | 'MENSUAL';
    },
    tx?: Tx,
  ): Promise<PagoProgramado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const creado = fila<{ id: string }>(
          await t.query(
            `INSERT INTO pago_programado
               (empresa_id, descripcion, tercero_id, compra_id, concepto_id, valor, fecha,
                recurrencia, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              ctx.empresaId,
              datos.descripcion.trim(),
              datos.terceroId ?? null,
              datos.compraId ?? null,
              datos.conceptoId ?? null,
              datos.valor,
              datos.fecha,
              datos.recurrencia,
              ctx.usuarioId,
            ],
          ),
        );
        if (creado === undefined)
          throw new BadRequestException('No se pudo programar el pago.');
        return this.obtener(ctx, creado.id, t);
      },
      tx,
    );
  }

  /** Lo marca pagado; si es mensual, programa el del mes siguiente. */
  async marcarPagado(
    ctx: CtxEmpresa,
    id: string,
    datos: { comprobanteId?: string; movimientoId?: string },
    tx?: Tx,
  ): Promise<PagoProgramado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const p = await this.pendiente(id, t);
        await t.query(
          `UPDATE pago_programado
              SET estado = 'PAGADO', comprobante_id = $2, movimiento_id = $3,
                  resuelto_en = now(), resuelto_por = $4
            WHERE id = $1`,
          [
            id,
            datos.comprobanteId ?? null,
            datos.movimientoId ?? null,
            ctx.usuarioId,
          ],
        );
        if (p.recurrencia === 'MENSUAL') {
          await this.crear(
            ctx,
            {
              descripcion: p.descripcion,
              terceroId: p.tercero_id ?? undefined,
              conceptoId: p.concepto_id ?? undefined,
              valor: Number(p.valor),
              fecha: mesSiguiente(p.fecha),
              recurrencia: 'MENSUAL',
            },
            t,
          );
        }
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  /** Lo cancela: ya no se va a pagar. Un mensual cancelado deja de repetirse. */
  async cancelar(ctx: CtxEmpresa, id: string): Promise<PagoProgramado> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.pendiente(id, t);
      await t.query(
        `UPDATE pago_programado
            SET estado = 'CANCELADO', resuelto_en = now(), resuelto_por = $2
          WHERE id = $1`,
        [id, ctx.usuarioId],
      );
      return this.obtener(ctx, id, t);
    });
  }

  private async pendiente(id: string, t: Tx) {
    const p = fila<{
      estado: string;
      descripcion: string;
      tercero_id: string | null;
      concepto_id: string | null;
      valor: string;
      fecha: string;
      recurrencia: 'UNA_VEZ' | 'MENSUAL';
    }>(
      await t.query(
        `SELECT estado, descripcion, tercero_id, concepto_id, valor, fecha, recurrencia
           FROM pago_programado WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (p === undefined)
      throw new NotFoundException('Ese pago programado no existe.');
    if (p.estado !== 'PENDIENTE')
      throw new BadRequestException('Este pago ya no está pendiente.');
    return p;
  }

  private async obtener(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<PagoProgramado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS} FROM pago_programado p WHERE p.id = $1`,
            [id],
          ),
        );
        if (f === undefined)
          throw new NotFoundException('Ese pago programado no existe.');
        return aProgramado(f);
      },
      tx,
    );
  }
}

function aProgramado(f: Record<string, unknown>): PagoProgramado {
  return {
    id: f.id as string,
    descripcion: f.descripcion as string,
    terceroId: f.tercero_id as string | null,
    terceroNombre: f.tercero_nombre as string | null,
    compraId: f.compra_id as string | null,
    conceptoId: f.concepto_id as string | null,
    conceptoNombre: f.concepto_nombre as string | null,
    valor: Number(f.valor),
    fecha: f.fecha as string,
    recurrencia: f.recurrencia as 'UNA_VEZ' | 'MENSUAL',
    estado: f.estado as 'PENDIENTE' | 'PAGADO' | 'CANCELADO',
  };
}
