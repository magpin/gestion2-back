import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import {
  compararPeriodos,
  dejaHueco,
  etiquetaPeriodo,
  grupoDe,
  mesAnterior,
  mesesACrear,
  periodoDeFecha,
  primerDiaDelPeriodo,
  type Agrupacion,
  type Periodo as PeriodoCalendario,
} from './periodo.reglas';

export interface Periodo {
  id: string;
  anio: number;
  mes: number;
  estado: 'ABIERTO' | 'CERRADO';
  cerrado_en: string | null;
  cerrado_por: string | null;
  /** Lo cerró el sistema al terminar el mes, no una persona. */
  cierre_automatico?: boolean;
}

/** Un mes, un trimestre, un semestre o un año, con sus cifras. */
export interface ResumenPeriodo {
  /** `2026-09`, `2026-T3`, `2026-S2` o `2026`. */
  grupo: string;
  /** ABIERTO si alguno de sus meses lo está: es el que está en curso. */
  estado: 'ABIERTO' | 'CERRADO';
  desde: PeriodoCalendario;
  hasta: PeriodoCalendario;
  asientos: number;
  /** Clase 4: créditos menos débitos. */
  ingresos: number;
  /** Clases 5, 6 y 7: débitos menos créditos. */
  costosGastos: number;
  /** Ingresos menos costos y gastos: la utilidad, o la pérdida si es negativo. */
  resultado: number;
  meses: Array<Periodo & { asientos: number }>;
}

/** Dónde se asienta una fecha, y si hubo que moverla. */
export interface DestinoAsiento {
  periodo: Periodo;
  /** La fecha contable: la del documento, o el primer día del mes abierto. */
  fecha: string;
  /** El mes del documento ya estaba cerrado y el asiento se pasó al abierto. */
  movida: boolean;
}

const CAMPOS = `id, anio, mes, estado, cerrado_en, cerrado_por, cierre_automatico`;

/**
 * El calendario contable: qué meses existen y cuáles aceptan escritura.
 *
 * Cerrar un mes es una promesa —los estados financieros que salieron de ahí no
 * cambian—, y por eso las dos operaciones que la rompen, cerrar sin el anterior
 * cerrado y reabrir con uno posterior cerrado, se bloquean acá.
 *
 * El candado en sí no vive en este servicio: lo aplica `fn_candado_periodo` sobre
 * `asiento`. Acá se administra el calendario; allá se hace cumplir.
 *
 * **El calendario es automático** (`sincronizar`): el mes en curso existe y
 * está abierto, y el último día de cada mes se cierra solo. Lo que llega con
 * fecha de un mes cerrado se asienta en el mes abierto (`periodoParaAsentar`).
 * Nadie abre ni cierra meses a mano.
 */
@Injectable()
export class PeriodoService {
  constructor(private readonly tx: TxService) {}

  async listar(ctx: CtxEmpresa, anio?: number): Promise<Periodo[]> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.sincronizar(ctx, t);
      const condicion = anio === undefined ? '' : 'WHERE anio = $1';
      const params = anio === undefined ? [] : [anio];

      return filas<Periodo>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM periodo_contable ${condicion}
            ORDER BY anio DESC, mes DESC`,
          params,
        ),
      );
    });
  }

  /**
   * Pone el calendario al día con la fecha de hoy (hora de Colombia):
   *
   * 1. Crea los meses que falten hasta el actual, sin dejar huecos.
   * 2. Cierra, en orden, todo mes abierto que ya terminó, congelando sus saldos.
   *
   * Idempotente y barato cuando no hay nada que hacer. Se corre antes de
   * asentar y al consultar el calendario, así que está al día en cuanto alguien
   * usa el sistema; no depende de una tarea programada. El candado evita que
   * dos operaciones simultáneas de la misma empresa lo corran a la vez.
   */
  async sincronizar(
    ctx: CtxEmpresa,
    t: Tx,
  ): Promise<{ actual: PeriodoCalendario; mesCierreFiscal: number }> {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext('periodos:' || $1))`, [
      ctx.empresaId,
    ]);
    const mesCierreFiscal = await this.mesCierreFiscal(t, ctx);
    const actual = periodoDeFecha(
      new Date(`${hoyEnColombia()}T12:00:00`),
      mesCierreFiscal,
    );

    const existentes = filas<PeriodoCalendario>(
      await t.query('SELECT anio, mes FROM periodo_contable'),
    );
    for (const p of mesesACrear(existentes, actual)) {
      await t.query(
        `INSERT INTO periodo_contable (empresa_id, anio, mes)
         VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id, anio, mes) DO NOTHING`,
        [ctx.empresaId, p.anio, p.mes],
      );
    }

    // En orden: el saldo inicial de cada mes sale del final del anterior.
    const terminados = filas<Periodo>(
      await t.query(
        `SELECT ${CAMPOS} FROM periodo_contable
          WHERE estado = 'ABIERTO' AND (anio < $1 OR (anio = $1 AND mes < $2))
          ORDER BY anio, mes`,
        [actual.anio, actual.mes],
      ),
    );
    for (const p of terminados) {
      await this.congelarSaldos(t, ctx, p);
      await t.query(
        `UPDATE periodo_contable
            SET estado = 'CERRADO', cerrado_en = now(), cerrado_por = $2,
                cierre_automatico = true
          WHERE id = $1`,
        [p.id, ctx.usuarioId],
      );
    }

    return { actual, mesCierreFiscal };
  }

  /**
   * Dónde se asienta un documento de esta fecha (AAAA-MM-DD).
   *
   * - Su mes está abierto: ahí, con su fecha.
   * - Su mes ya se cerró (o nunca existió porque es anterior a todo): en el
   *   mes abierto, el primer día. Quien llama anota la fecha original.
   * - Su mes todavía no empieza: se rechaza. No se asienta en el futuro.
   */
  async periodoParaAsentar(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<DestinoAsiento> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const { actual, mesCierreFiscal } = await this.sincronizar(ctx, t);
        const delDocumento = periodoDeFecha(
          new Date(`${fecha}T12:00:00`),
          mesCierreFiscal,
        );

        if (compararPeriodos(delDocumento, actual) > 0) {
          throw new BadRequestException(
            `La fecha ${fecha} es de un mes que todavía no empieza (${etiquetaPeriodo(delDocumento)}). No se registran asientos en el futuro.`,
          );
        }

        const propio = await this.buscar(t, delDocumento);
        if (propio?.estado === 'ABIERTO') {
          return { periodo: propio, fecha, movida: false };
        }

        const abierto = await this.buscar(t, actual);
        if (abierto === null || abierto.estado !== 'ABIERTO') {
          throw new BadRequestException(
            `El período ${etiquetaPeriodo(actual)} está cerrado y no hay dónde registrar. Reábralo para seguir.`,
          );
        }
        return {
          periodo: abierto,
          fecha: primerDiaDelPeriodo(actual, mesCierreFiscal),
          movida: true,
        };
      },
      tx,
    );
  }

  /** Si un documento de esta fecha se puede asentar hoy (sin lanzar). */
  async puedeAsentar(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<boolean> {
    try {
      await this.periodoParaAsentar(ctx, fecha, tx);
      return true;
    } catch (e) {
      if (e instanceof BadRequestException) return false;
      throw e;
    }
  }

  /**
   * El calendario agrupado —por mes, trimestre, semestre o año— con sus
   * cifras: asientos, ingresos (clase 4), costos y gastos (clases 5, 6 y 7) y
   * el resultado. Solo asientos REGISTRADOS.
   */
  async resumen(
    ctx: CtxEmpresa,
    agrupacion: Agrupacion,
    anio?: number,
  ): Promise<ResumenPeriodo[]> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.sincronizar(ctx, t);
      const condicion = anio === undefined ? '' : 'WHERE p.anio = $1';
      const meses = filas<
        Periodo & {
          asientos: number;
          ingresos: string | null;
          costos_gastos: string | null;
        }
      >(
        await t.query(
          `SELECT p.id, p.anio, p.mes, p.estado, p.cerrado_en, p.cerrado_por,
                  p.cierre_automatico,
                  (SELECT count(*)::int FROM asiento a
                    WHERE a.periodo_id = p.id AND a.estado = 'REGISTRADO') AS asientos,
                  (SELECT sum(al.credito - al.debito)
                     FROM asiento a
                     JOIN asiento_linea al ON al.asiento_id = a.id
                     JOIN empresa_cuenta ec ON ec.id = al.cuenta_id
                    WHERE a.periodo_id = p.id AND a.estado = 'REGISTRADO'
                      AND ec.codigo LIKE '4%') AS ingresos,
                  (SELECT sum(al.debito - al.credito)
                     FROM asiento a
                     JOIN asiento_linea al ON al.asiento_id = a.id
                     JOIN empresa_cuenta ec ON ec.id = al.cuenta_id
                    WHERE a.periodo_id = p.id AND a.estado = 'REGISTRADO'
                      AND left(ec.codigo, 1) IN ('5', '6', '7')) AS costos_gastos
             FROM periodo_contable p ${condicion}
            ORDER BY p.anio, p.mes`,
          anio === undefined ? [] : [anio],
        ),
      );

      const grupos = new Map<string, ResumenPeriodo>();
      for (const m of meses) {
        const clave = grupoDe(m, agrupacion);
        const g = grupos.get(clave) ?? {
          grupo: clave,
          estado: 'CERRADO',
          desde: { anio: m.anio, mes: m.mes },
          hasta: { anio: m.anio, mes: m.mes },
          asientos: 0,
          ingresos: 0,
          costosGastos: 0,
          resultado: 0,
          meses: [],
        };
        const ingresos = Number(m.ingresos ?? 0);
        const costos = Number(m.costos_gastos ?? 0);
        g.hasta = { anio: m.anio, mes: m.mes };
        g.asientos += m.asientos;
        g.ingresos = redondear(g.ingresos + ingresos);
        g.costosGastos = redondear(g.costosGastos + costos);
        g.resultado = redondear(g.ingresos - g.costosGastos);
        if (m.estado === 'ABIERTO') g.estado = 'ABIERTO';
        g.meses.push({
          id: m.id,
          anio: m.anio,
          mes: m.mes,
          estado: m.estado,
          cerrado_en: m.cerrado_en,
          cerrado_por: m.cerrado_por,
          cierre_automatico: m.cierre_automatico,
          asientos: m.asientos,
        });
        grupos.set(clave, g);
      }
      // El más reciente primero: es el que se viene a mirar.
      return [...grupos.values()].reverse();
    });
  }

  /**
   * El período en el que cae una fecha, si existe.
   *
   * Devuelve `null` y no lanza: preguntar por un mes que nadie abrió todavía es
   * normal —la pantalla lo usa para saber si ofrecer el botón de abrirlo—.
   */
  /** El período en curso, con el calendario puesto al día. */
  async actual(ctx: CtxEmpresa): Promise<Periodo | null> {
    return this.tx.enContexto(ctx, async (t) => {
      const { actual } = await this.sincronizar(ctx, t);
      return this.buscar(t, actual);
    });
  }

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
      // Con el calendario automático el mes en curso ya existe: pedir abrirlo
      // no es un error, es llegar tarde.
      const yaExiste = await this.buscar(t, { anio, mes });
      if (yaExiste !== null) return yaExiste;

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
    return periodoDeFecha(fecha, await this.mesCierreFiscal(t, ctx));
  }

  private async mesCierreFiscal(t: Tx, ctx: CtxEmpresa): Promise<number> {
    const config = fila<{ mes_cierre_fiscal: number }>(
      await t.query(
        'SELECT mes_cierre_fiscal FROM empresa_configuracion_contable WHERE empresa_id = $1',
        [ctx.empresaId],
      ),
    );
    // Sin configuración contable la empresa no terminó de configurarse. El año
    // calendario es el supuesto correcto y no una adivinanza: es el caso de
    // lejos más común y el que la propia columna trae por defecto.
    return config?.mes_cierre_fiscal ?? 12;
  }

  private async buscar(t: Tx, p: PeriodoCalendario): Promise<Periodo | null> {
    return (
      fila<Periodo>(
        await t.query(
          `SELECT ${CAMPOS} FROM periodo_contable WHERE anio = $1 AND mes = $2`,
          [p.anio, p.mes],
        ),
      ) ?? null
    );
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
        `Cierre primero ${etiquetaPeriodo(anterior)}: el saldo inicial de ${etiquetaPeriodo(periodo)} sale de ahi y todavia puede cambiar.`,
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

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
