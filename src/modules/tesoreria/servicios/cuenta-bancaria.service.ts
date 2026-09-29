import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearCuentaBancariaDto } from '../dto/cuenta-bancaria.dto';

export interface CuentaBancaria {
  id: string;
  banco: string;
  numero_cuenta: string;
  tipo_cuenta: 'AHORROS' | 'CORRIENTE' | 'BILLETERA';
  cuenta_id: string;
  activa: boolean;
  /** Exenta del 4×1000 (art. 879 num. 1 ET): una sola cuenta por titular. */
  exenta_gmf: boolean;
  /** Hasta qué día está conciliada con el extracto; `null` si nunca se concilió. */
  conciliada_hasta: string | null;
  /** Cuánta plata hay hoy. Puede ser negativo: el banco admite sobregiro. */
  saldo: string;
  /** El día del último movimiento, o `null` si no hubo ninguno. */
  ultimo_movimiento: string | null;
  /**
   * El mapeo de columnas del último extracto subido, para no volver a
   * pedirlo el mes siguiente. Lo interpreta el frontend; acá solo se guarda.
   */
  formato_extracto: Record<string, unknown> | null;
}

/** Igual que en `CajaService`, y allá está escrito el porqué. */
const ultimo = (columna: string, porDefecto: string) =>
  `(SELECT coalesce(
      (SELECT m.${columna} FROM banco_movimiento m
        WHERE m.cuenta_bancaria_id = cuenta_bancaria.id
        ORDER BY m.secuencia DESC
        LIMIT 1), ${porDefecto}))`;

const CAMPOS = `id, banco, numero_cuenta, tipo_cuenta, cuenta_id, activa, exenta_gmf,
                formato_extracto,
                ${ultimo('saldo_valor', '0')} AS saldo,
                ${ultimo('fecha', 'NULL')} AS ultimo_movimiento,
                (SELECT max(e.fecha_hasta)::text FROM extracto_bancario e
                  WHERE e.cuenta_bancaria_id = cuenta_bancaria.id AND e.estado = 'CONCILIADO')
                  AS conciliada_hasta`;

/**
 * El maestro de cuentas bancarias. Sin movimientos todavía —eso es
 * `BancoMovimientoService`, que necesita el candado de concurrencia y no
 * comparte nada con el CRUD de acá— mismo criterio que separa
 * `CajaService` de `CajaMovimientoService`.
 */
@Injectable()
export class CuentaBancariaService {
  constructor(private readonly tx: TxService) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearCuentaBancariaDto,
  ): Promise<CuentaBancaria> {
    return this.tx.enContexto(ctx, async (t) => {
      const creada = fila<CuentaBancaria>(
        await t.query(
          `INSERT INTO cuenta_bancaria
             (empresa_id, banco, numero_cuenta, tipo_cuenta, cuenta_id, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${CAMPOS}`,
          [
            ctx.empresaId,
            dto.banco,
            dto.numeroCuenta,
            dto.tipoCuenta,
            dto.cuentaId,
            ctx.usuarioId,
          ],
        ),
      );

      if (creada === undefined) {
        throw new BadRequestException('No se pudo crear la cuenta bancaria.');
      }
      return creada;
    });
  }

  async listar(
    ctx: CtxEmpresa,
    filtro: { incluirInactivas?: 'true' | 'false' } = {},
  ): Promise<CuentaBancaria[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const where = filtro.incluirInactivas === 'true' ? '' : 'WHERE activa';
      return filas<CuentaBancaria>(
        await t.query(
          `SELECT ${CAMPOS} FROM cuenta_bancaria ${where} ORDER BY banco, numero_cuenta`,
        ),
      );
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<CuentaBancaria> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrada = fila<CuentaBancaria>(
        await t.query(`SELECT ${CAMPOS} FROM cuenta_bancaria WHERE id = $1`, [
          id,
        ]),
      );
      if (encontrada === undefined) {
        throw new NotFoundException('Cuenta bancaria no encontrada');
      }
      return encontrada;
    });
  }

  /**
   * Igual que `porId`, pero para consumo interno (`BancoMovimientoService`,
   * `TesoreriaApi`): devuelve `null` en vez de lanzar, y acepta `tx` para
   * engancharse a una transacción ajena — mismo criterio que
   * `CajaService.buscar`.
   */
  async buscar(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<CuentaBancaria | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const encontrada = fila<CuentaBancaria>(
          await t.query(`SELECT ${CAMPOS} FROM cuenta_bancaria WHERE id = $1`, [
            id,
          ]),
        );
        return encontrada ?? null;
      },
      tx,
    );
  }

  /** No borra: desactiva. Una cuenta bancaria con movimientos no se puede quitar. */
  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE cuenta_bancaria SET activa = false WHERE id = $1', [id]),
    );
  }

  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE cuenta_bancaria SET activa = true WHERE id = $1', [id]),
    );
  }
}
