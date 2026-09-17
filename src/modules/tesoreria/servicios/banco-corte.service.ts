import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { esFechaFutura } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CerrarCorteDto, ListarCortesDto } from '../dto/banco-corte.dto';
import {
  CAMPOS_MOVIMIENTO_BANCO,
  DIRECCION_MOVIMIENTO_BANCO,
  type MovimientoBancoResumen,
} from './banco-movimiento.service';
import { armarCorte } from './banco.reglas';

export interface CorteBancoResumen {
  id: string;
  cuenta_bancaria_id: string;
  fecha: string;
  saldo_anterior: string;
  entradas: string;
  salidas: string;
  saldo_final: string;
  movimientos: number;
  saldo_banco: string | null;
  diferencia: string | null;
  nota: string | null;
  cerrado_en: string;
  cerrado_por: string;
  /**
   * Movimientos registrados después del corte con fecha de ese día o de uno
   * anterior: los que hacen que el corte ya no coincida con el libro. Un
   * corte no bloquea el libro —ver `0046_banco_corte.sql`—, así que esto es
   * cómo se entera quien mira.
   */
  cambios_posteriores: number;
}

/** El día tal como está hoy en el libro, cortado o no. */
export interface PrevioCorte {
  fecha: string;
  saldo_anterior: number;
  entradas: number;
  salidas: number;
  saldo_final: number;
  movimientos: MovimientoBancoResumen[];
  /** El corte de ese día, si ya se hizo. */
  corte: CorteBancoResumen | null;
}

const CAMPOS = `id, cuenta_bancaria_id, to_char(fecha, 'YYYY-MM-DD') AS fecha,
                saldo_anterior, entradas, salidas, saldo_final, movimientos,
                saldo_banco, diferencia, nota, cerrado_en, cerrado_por,
                (SELECT count(*)::int FROM banco_movimiento m
                  WHERE m.cuenta_bancaria_id = banco_corte.cuenta_bancaria_id
                    AND m.fecha <= banco_corte.fecha
                    AND m.creado_en > banco_corte.cerrado_en) AS cambios_posteriores`;

/**
 * Lo que suma: el saldo inicial y los tipos de entrada. Sale del mismo mapa que
 * usa el libro para decidir el comprobante, y no de una lista aparte: si un
 * día aparece un tipo nuevo, el corte lo clasifica igual que el asiento.
 */
const TIPOS_QUE_SUMAN = [
  'SALDO_INICIAL',
  ...Object.entries(DIRECCION_MOVIMIENTO_BANCO)
    .filter(([, direccion]) => direccion === 'ENTRADA')
    .map(([tipo]) => tipo),
];

/**
 * El corte diario de una cuenta bancaria: qué entró y qué salió un día, contra
 * el saldo con que amaneció, congelado al cerrar. El arqueo de la caja sin
 * billetes —el saldo del banco se lee, no se cuenta—.
 *
 * No bloquea el libro. Ver el porqué en `0046_banco_corte.sql`.
 */
@Injectable()
export class BancoCorteService {
  constructor(private readonly tx: TxService) {}

  /** El día, calculado del libro como está ahora, y su corte si ya lo tiene. */
  async previo(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    fecha: string,
  ): Promise<PrevioCorte> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCuenta(cuentaBancariaId, t, false);
      const totales = await this.totalesDelDia(cuentaBancariaId, fecha, t);

      const movimientos = filas<MovimientoBancoResumen>(
        await t.query(
          `SELECT ${CAMPOS_MOVIMIENTO_BANCO}
             FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1 AND fecha = $2 AND tipo <> 'SALDO_INICIAL'
            ORDER BY secuencia`,
          [cuentaBancariaId, fecha],
        ),
      );

      const corte =
        fila<CorteBancoResumen>(
          await t.query(
            `SELECT ${CAMPOS} FROM banco_corte
              WHERE cuenta_bancaria_id = $1 AND fecha = $2`,
            [cuentaBancariaId, fecha],
          ),
        ) ?? null;

      return {
        fecha,
        saldo_anterior: totales.saldoAnterior,
        entradas: totales.entradas,
        salidas: totales.salidas,
        saldo_final: totales.saldoFinal,
        movimientos,
        corte,
      };
    });
  }

  /**
   * Corta un día. Los números salen del libro en la misma transacción, con la
   * cuenta bloqueada: un movimiento que se registre al mismo tiempo entra
   * antes o después del corte, no a medias.
   */
  async cerrar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: CerrarCorteDto,
  ): Promise<CorteBancoResumen> {
    if (esFechaFutura(dto.fecha)) {
      throw new BadRequestException(
        'La fecha del corte es posterior a hoy: se corta un día que ya pasó o el de hoy.',
      );
    }

    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCuenta(cuentaBancariaId, t, true);

      const existente = fila<{ id: string }>(
        await t.query(
          'SELECT id FROM banco_corte WHERE cuenta_bancaria_id = $1 AND fecha = $2',
          [cuentaBancariaId, dto.fecha],
        ),
      );
      if (existente !== undefined) {
        throw new BadRequestException(
          `El ${dto.fecha} ya se cortó para esta cuenta. Un corte no se rehace: si algo cambió después, el historial lo muestra.`,
        );
      }

      const totales = await this.totalesDelDia(
        cuentaBancariaId,
        dto.fecha,
        t,
        dto.saldoBanco,
      );

      const creado = fila<CorteBancoResumen>(
        await t.query(
          `INSERT INTO banco_corte
             (id, empresa_id, cuenta_bancaria_id, fecha, saldo_anterior, entradas,
              salidas, saldo_final, movimientos, saldo_banco, diferencia, nota,
              cerrado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING ${CAMPOS}`,
          [
            randomUUID(),
            ctx.empresaId,
            cuentaBancariaId,
            dto.fecha,
            totales.saldoAnterior,
            totales.entradas,
            totales.salidas,
            totales.saldoFinal,
            totales.movimientos,
            totales.saldoBanco,
            totales.diferencia,
            dto.nota?.trim() || null,
            ctx.usuarioId,
          ],
        ),
      );
      if (creado === undefined) {
        throw new BadRequestException('No se pudo cerrar el corte.');
      }
      return creado;
    });
  }

  /** Los cortes de una cuenta, el más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    p: ListarCortesDto,
  ): Promise<Pagina<CorteBancoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM banco_corte WHERE cuenta_bancaria_id = $1',
          [cuentaBancariaId],
        ),
      );
      const datos = filas<CorteBancoResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM banco_corte
            WHERE cuenta_bancaria_id = $1
            ORDER BY fecha DESC
            LIMIT $2 OFFSET $3`,
          [cuentaBancariaId, p.tamano, p.salto],
        ),
      );
      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * La cuenta tiene que existir. Para cortar, además activa y bloqueada —mismo
   * candado que usa el libro al registrar—; para mirar, una cuenta inactiva
   * también tiene historia.
   */
  private async exigirCuenta(
    cuentaBancariaId: string,
    t: Tx,
    paraCortar: boolean,
  ): Promise<void> {
    const cuenta = fila<{ id: string }>(
      await t.query(
        paraCortar
          ? 'SELECT id FROM cuenta_bancaria WHERE id = $1 AND activa FOR UPDATE'
          : 'SELECT id FROM cuenta_bancaria WHERE id = $1',
        [cuentaBancariaId],
      ),
    );
    if (cuenta === undefined) {
      throw new NotFoundException(
        paraCortar
          ? 'Cuenta bancaria no encontrada o inactiva'
          : 'Cuenta bancaria no encontrada',
      );
    }
  }

  /**
   * Los números de un día, por fecha del hecho y no por orden de digitación:
   * el corte responde "cómo cerró el martes", y un movimiento del martes
   * registrado el jueves es del martes.
   *
   * El saldo inicial va siempre al saldo anterior, aunque tenga la fecha del
   * día: no es plata que entró, es de dónde arrancó la cuenta —mismo criterio
   * que el resumen del libro—.
   */
  private async totalesDelDia(
    cuentaBancariaId: string,
    fecha: string,
    t: Tx,
    saldoBanco?: number,
  ) {
    const sumas = fila<{
      saldo_anterior: string;
      entradas: string;
      salidas: string;
      movimientos: number;
    }>(
      await t.query(
        `SELECT
           coalesce(sum(CASE WHEN tipo = ANY($3::text[]) THEN valor ELSE -valor END)
             FILTER (WHERE fecha < $2 OR (fecha = $2 AND tipo = 'SALDO_INICIAL')), 0)::text AS saldo_anterior,
           coalesce(sum(valor)
             FILTER (WHERE fecha = $2 AND tipo <> 'SALDO_INICIAL' AND tipo = ANY($3::text[])), 0)::text AS entradas,
           coalesce(sum(valor)
             FILTER (WHERE fecha = $2 AND NOT (tipo = ANY($3::text[]))), 0)::text AS salidas,
           (count(*) FILTER (WHERE fecha = $2 AND tipo <> 'SALDO_INICIAL'))::int AS movimientos
         FROM banco_movimiento
        WHERE cuenta_bancaria_id = $1`,
        [cuentaBancariaId, fecha, TIPOS_QUE_SUMAN],
      ),
    );
    const corte = armarCorte(
      Number(sumas?.saldo_anterior ?? 0),
      Number(sumas?.entradas ?? 0),
      Number(sumas?.salidas ?? 0),
      saldoBanco,
    );
    return { ...corte, movimientos: sumas?.movimientos ?? 0 };
  }
}
