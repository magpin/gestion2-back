import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  dejaHueco,
  etiquetaPeriodo,
  mesAnterior,
  periodoDeFecha,
  type Periodo as PeriodoCalendario,
} from './periodo.reglas';

export interface Periodo {
  id: string;
  anio: number;
  mes: number;
  estado: 'ABIERTO' | 'CERRADO';
  cerrado_en: string | null;
  cerrado_por: string | null;
}

/**
 * El calendario contable: qué meses existen y cuáles aceptan escritura.
 *
 * Cerrar un mes es una promesa —los estados financieros que salieron de ahí no
 * cambian—, y por eso las dos operaciones que la rompen, cerrar sin el anterior
 * cerrado y reabrir con uno posterior cerrado, se bloquean acá.
 *
 * El candado en sí no vive en este servicio: lo aplica `fn_candado_periodo` sobre
 * `asiento`. Acá se administra el calendario; allá se hace cumplir.
 */
@Injectable()
export class PeriodoService {
  constructor(private readonly tx: TxService) {}

  async listar(ctx: CtxEmpresa, anio?: number): Promise<Periodo[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const condicion = anio === undefined ? '' : 'WHERE anio = $1';
      const params = anio === undefined ? [] : [anio];

      return filas<Periodo>(
        await t.query(
          `SELECT id, anio, mes, estado, cerrado_en, cerrado_por
             FROM periodo_contable ${condicion}
            ORDER BY anio DESC, mes DESC`,
          params,
        ),
      );
    });
  }

  /**
   * El período en el que cae una fecha, si existe.
   *
   * Devuelve `null` y no lanza: preguntar por un mes que nadie abrió todavía es
   * normal —la pantalla lo usa para saber si ofrecer el botón de abrirlo—.
   */
  async porFecha(
    ctx: CtxEmpresa,
    fecha: Date,
    tx?: Tx,
  ): Promise<Periodo | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const { anio, mes } = await this.calendario(t, ctx, fecha);
        return (
          fila<Periodo>(
            await t.query(
              `SELECT id, anio, mes, estado, cerrado_en, cerrado_por
                 FROM periodo_contable WHERE anio = $1 AND mes = $2`,
              [anio, mes],
            ),
          ) ?? null
        );
      },
      tx,
    );
  }

  /**
   * El período donde asentar una fecha, o el error que explica por qué no.
   *
   * Lo usa `asiento.service` antes de escribir. Falla acá y no en el trigger
   * porque acá todavía se puede decir de qué mes se trata y qué hacer; el
   * trigger dispara con la fila ya armada.
   */
  async exigirAbierto(ctx: CtxEmpresa, fecha: Date, tx?: Tx): Promise<Periodo> {
    const periodo = await this.porFecha(ctx, fecha, tx);
    const etiqueta = etiquetaPeriodo(
      await this.tx.enContexto(ctx, (t) => this.calendario(t, ctx, fecha), tx),
    );

    if (periodo === null) {
      throw new BadRequestException(
        `El periodo ${etiqueta} no esta abierto. Abrilo antes de registrar asientos con esa fecha.`,
      );
    }
    if (periodo.estado === 'CERRADO') {
      throw new BadRequestException(
        `El periodo ${etiqueta} esta cerrado. Registra el ajuste en un periodo abierto, o reabrilo.`,
      );
    }
    return periodo;
  }

  /**
   * Abre un mes.
   *
   * No deja saltarse meses: abrir marzo con febrero sin abrir parece inofensivo
   * hasta el cierre, cuando el saldo inicial de marzo tiene que salir del saldo
   * final de un febrero que no existe.
   *
   * Hacia atrás sí se puede abrir libremente: es lo que hace falta al migrar
   * saldos de un sistema anterior.
   */
  async abrir(ctx: CtxEmpresa, anio: number, mes: number): Promise<Periodo> {
    return this.tx.enContexto(ctx, async (t) => {
      const existentes = filas<PeriodoCalendario>(
        await t.query('SELECT anio, mes FROM periodo_contable'),
      );

      if (dejaHueco(existentes, { anio, mes })) {
        const previo = etiquetaPeriodo(mesAnterior({ anio, mes }));
        throw new BadRequestException(
          `No se puede abrir ${etiquetaPeriodo({ anio, mes })} sin abrir antes ${previo}: el saldo inicial sale del mes anterior.`,
        );
      }

      const creado = fila<Periodo>(
        await t.query(
          `INSERT INTO periodo_contable (empresa_id, anio, mes)
           VALUES ($1, $2, $3)
           RETURNING id, anio, mes, estado, cerrado_en, cerrado_por`,
          [ctx.empresaId, anio, mes],
        ),
      );

      if (creado === undefined) {
        throw new BadRequestException('No se pudo abrir el periodo.');
      }
      return creado;
    });
  }

  /**
   * Cierra un mes y congela sus saldos.
   *
   * El orden importa: primero se verifica que el anterior esté cerrado, porque
   * el saldo inicial de este sale del saldo final de aquel. Cerrar marzo con
   * febrero abierto produce un arrastre que va a cambiar.
   *
   * Los saldos se calculan y se guardan; no se derivan después. El saldo de un
   * período cerrado es un hecho, y recalcularlo contra las líneas de mañana
   * podría dar otro número si algo se reabrió en el medio.
   */
  async cerrar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const periodo = await this.exigirPeriodo(t, id);

      if (periodo.estado === 'CERRADO') {
        throw new BadRequestException(
          `El periodo ${etiquetaPeriodo(periodo)} ya esta cerrado.`,
        );
      }

      await this.exigirAnteriorCerrado(t, periodo);
      await this.congelarSaldos(t, ctx, periodo);

      await t.query(
        `UPDATE periodo_contable
            SET estado = 'CERRADO', cerrado_en = now(), cerrado_por = $2
          WHERE id = $1`,
        [id, ctx.usuarioId],
      );
    });
  }

  /**
   * Reabre un mes cerrado.
   *
   * Falla si hay un período posterior cerrado: el saldo inicial de ese posterior
   * salió del saldo final de este, y cambiarlo lo dejaría mintiendo sin que nada
   * lo delate.
   *
   * Los saldos congelados se borran. Se vuelven a calcular al cerrar de nuevo.
   */
  async reabrir(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const periodo = await this.exigirPeriodo(t, id);

      if (periodo.estado === 'ABIERTO') {
        throw new BadRequestException(
          `El periodo ${etiquetaPeriodo(periodo)} ya esta abierto.`,
        );
      }

      const posteriorCerrado = fila<PeriodoCalendario>(
        await t.query(
          `SELECT anio, mes FROM periodo_contable
            WHERE estado = 'CERRADO'
              AND (anio > $1 OR (anio = $1 AND mes > $2))
            ORDER BY anio, mes LIMIT 1`,
          [periodo.anio, periodo.mes],
        ),
      );

      if (posteriorCerrado !== undefined) {
        throw new BadRequestException(
          `No se puede reabrir ${etiquetaPeriodo(periodo)} con ${etiquetaPeriodo(posteriorCerrado)} cerrado: su saldo inicial quedaria mintiendo. Reabri primero el mas reciente.`,
        );
      }

      // Los saldos congelados son un cálculo, no un hecho: se derivaron de las
      // líneas al cerrar. Dejarlos sería peor que borrarlos —el mes siguiente
      // arrancaría de un saldo inicial que ya nadie recalculó—. El permiso lo da
      // `0023`; los asientos del período no se tocan.
      await t.query('DELETE FROM saldo_cuenta_periodo WHERE periodo_id = $1', [
        id,
      ]);

      await t.query(
        `UPDATE periodo_contable
            SET estado = 'ABIERTO', cerrado_en = NULL, cerrado_por = NULL
          WHERE id = $1`,
        [id],
      );
    });
  }

  // ---------------------------------------------------------------------------

  /** El período calendario de una fecha, según el mes de cierre de la empresa. */
  private async calendario(
    t: Tx,
    ctx: CtxEmpresa,
    fecha: Date,
  ): Promise<PeriodoCalendario> {
    const config = fila<{ mes_cierre_fiscal: number }>(
      await t.query(
        'SELECT mes_cierre_fiscal FROM empresa_configuracion_contable WHERE empresa_id = $1',
        [ctx.empresaId],
      ),
    );

    // Sin configuración contable la empresa no terminó de configurarse. El año
    // calendario es el supuesto correcto y no una adivinanza: es el caso de
    // lejos más común y el que la propia columna trae por defecto.
    return periodoDeFecha(fecha, config?.mes_cierre_fiscal ?? 12);
  }

  private async exigirPeriodo(t: Tx, id: string): Promise<Periodo> {
    const periodo = fila<Periodo>(
      await t.query(
        `SELECT id, anio, mes, estado, cerrado_en, cerrado_por
           FROM periodo_contable WHERE id = $1`,
        [id],
      ),
    );

    if (periodo === undefined) {
      throw new NotFoundException('Periodo no encontrado');
    }
    return periodo;
  }

  private async exigirAnteriorCerrado(
    t: Tx,
    periodo: PeriodoCalendario,
  ): Promise<void> {
    const anterior = mesAnterior(periodo);

    const previo = fila<{ estado: string }>(
      await t.query(
        'SELECT estado FROM periodo_contable WHERE anio = $1 AND mes = $2',
        [anterior.anio, anterior.mes],
      ),
    );

    // No existe: es el primer período de la empresa, y no hay nada que arrastrar.
    if (previo === undefined) {
      const hayAnteriores = fila<{ existe: boolean }>(
        await t.query(
          `SELECT true AS existe FROM periodo_contable
            WHERE anio < $1 OR (anio = $1 AND mes < $2) LIMIT 1`,
          [periodo.anio, periodo.mes],
        ),
      );
      if (hayAnteriores === undefined) {
        return;
      }
      throw new BadRequestException(
        `Falta abrir ${etiquetaPeriodo(anterior)}: sin el, el saldo inicial de ${etiquetaPeriodo(periodo)} no se puede calcular.`,
      );
    }

    if (previo.estado !== 'CERRADO') {
      throw new BadRequestException(
        `Cerra primero ${etiquetaPeriodo(anterior)}: el saldo inicial de ${etiquetaPeriodo(periodo)} sale de ahi y todavia puede cambiar.`,
      );
    }
  }

  /**
   * Calcula y guarda el saldo de cada cuenta con movimiento en el período.
   *
   * `saldo_inicial` sale del `saldo_final` del período anterior; las cuentas que
   * no existían ahí arrancan en cero. Los asientos anulados no cuentan.
   *
   * La suma respeta la naturaleza de la cuenta —débito menos crédito, o al
   * revés— para que el saldo se lea como un número solo, sin invertir el signo
   * según de qué clase sea la cuenta.
   */
  private async congelarSaldos(
    t: Tx,
    ctx: CtxEmpresa,
    periodo: Periodo,
  ): Promise<void> {
    const anterior = mesAnterior(periodo);

    await t.query(
      `INSERT INTO saldo_cuenta_periodo
         (empresa_id, periodo_id, cuenta_id, saldo_inicial, debitos, creditos, saldo_final)
       SELECT
         $1,
         $2,
         c.id,
         coalesce(previo.saldo_final, 0),
         coalesce(mov.debitos, 0),
         coalesce(mov.creditos, 0),
         coalesce(previo.saldo_final, 0)
           + CASE WHEN c.naturaleza = 'DEBITO'
                  THEN coalesce(mov.debitos, 0) - coalesce(mov.creditos, 0)
                  ELSE coalesce(mov.creditos, 0) - coalesce(mov.debitos, 0)
             END
       FROM empresa_cuenta c
       LEFT JOIN (
         SELECT l.cuenta_id,
                sum(l.debito)  AS debitos,
                sum(l.credito) AS creditos
           FROM asiento_linea l
           JOIN asiento a ON a.id = l.asiento_id
          WHERE a.periodo_id = $2
            AND a.estado = 'REGISTRADO'
          GROUP BY l.cuenta_id
       ) mov ON mov.cuenta_id = c.id
       LEFT JOIN (
         SELECT s.cuenta_id, s.saldo_final
           FROM saldo_cuenta_periodo s
           JOIN periodo_contable p ON p.id = s.periodo_id
          WHERE p.anio = $3 AND p.mes = $4
       ) previo ON previo.cuenta_id = c.id
       WHERE c.empresa_id = $1
         AND c.es_auxiliar
         -- Sin movimiento y sin saldo previo no hay nada que congelar: guardar
         -- ceros por cada cuenta del plan infla la tabla sin decir nada.
         AND (mov.cuenta_id IS NOT NULL OR coalesce(previo.saldo_final, 0) <> 0)`,
      [ctx.empresaId, periodo.id, anterior.anio, anterior.mes],
    );
  }
}
