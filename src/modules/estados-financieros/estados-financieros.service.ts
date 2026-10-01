import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { fila, filas } from '../../common/db/filas';
import { TxService, type Tx } from '../../common/db/tx.service';
import { hoyEnColombia } from '../../common/fecha';
import { ComprasApi } from '../compras/compras.api';
import { VentasApi } from '../ventas/ventas.api';
import {
  balanceGeneral,
  estadoDeResultados,
  flujoDirecto,
  flujoProyectado,
  margen,
  mesDe,
  mesesHasta,
  resultadoDe,
  resultadosPorCentro,
  type CentroDeColumna,
  type ColumnaResultados,
  type Actividad,
  type AsientoDeCaja,
  type BalanceGeneral,
  type EstadoResultados,
  type FlujoDirecto,
  type MovimientoCuenta,
  type SaldoCuenta,
  type SemanaProyectada,
} from './estados.reglas';

/** El período que se mira: su rango y si el mes ya se cerró. */
export interface Periodo {
  mes: string;
  desde: string;
  hasta: string;
  /** El día al que se toma el balance: el último del mes, o hoy si el mes va en curso. */
  corte: string;
  estado: 'ABIERTO' | 'CERRADO' | 'SIN_PERIODO';
  asientos: number;
}

export interface Resultados {
  periodo: Periodo;
  actual: EstadoResultados;
  comparado: { periodo: Periodo; estado: EstadoResultados } | null;
  margenes: {
    bruto: number | null;
    operacional: number | null;
    antesDeImpuestos: number | null;
  };
  /** La utilidad antes de impuestos de los últimos seis meses, hasta el elegido. */
  porMes: Array<{ mes: string; utilidad: number }>;
}

export interface ResultadosPorCentro {
  periodo: Periodo;
  agrupar: 'CENTRO' | 'TIPO';
  columnas: ColumnaResultados[];
  total: EstadoResultados;
}

/**
 * Qué parte del libro mira el estado de resultados: todo (`undefined`), el id
 * de un centro de costo o lo que quedó sin centro (`SIN`).
 */
export type FiltroCentro = string | undefined;

/** El pedazo de WHERE de `FiltroCentro`, con su parámetro en la posición `n`. */
function condicionCentro(
  centro: FiltroCentro,
  n: number,
): { sql: string; params: string[] } {
  if (centro === undefined) return { sql: '', params: [] };
  if (centro === 'SIN') {
    return { sql: 'AND l.centro_costo_id IS NULL', params: [] };
  }
  return { sql: `AND l.centro_costo_id = $${n}`, params: [centro] };
}

export interface Balance {
  periodo: Periodo;
  actual: BalanceGeneral;
  comparado: { periodo: Periodo; balance: BalanceGeneral } | null;
}

export interface Flujo {
  periodo: Periodo;
  directo: FlujoDirecto;
}

export interface Proyectado {
  hoy: string;
  disponible: number;
  semanas: SemanaProyectada[];
}

const LIBRO = `
    FROM asiento_linea l
    JOIN asiento a ON a.id = l.asiento_id
    JOIN empresa_cuenta c ON c.id = l.cuenta_id
   WHERE a.estado = 'REGISTRADO'`;

/**
 * Análisis → Estados financieros. Salen del libro —las líneas de asiento
 * registradas—, así que cuadran con el balance de prueba por construcción.
 * **Solo lee.** Lee directo el libro, como `reportes`; lo pendiente de cobrar
 * y de pagar, por las fachadas de ventas y compras.
 */
@Injectable()
export class EstadosFinancierosService {
  constructor(
    private readonly tx: TxService,
    private readonly ventas: VentasApi,
    private readonly compras: ComprasApi,
  ) {}

  async resultados(
    ctx: CtxEmpresa,
    mes: string,
    comparar?: string,
    tx?: Tx,
    /** Solo un centro de costo, o lo que quedó sin centro (`SIN`). */
    centro?: FiltroCentro,
  ): Promise<Resultados> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const periodo = await this.periodo(mes, t);
        const actual = estadoDeResultados(
          await this.movimientos(periodo.desde, periodo.hasta, t, centro),
        );
        let comparado: Resultados['comparado'] = null;
        if (comparar !== undefined) {
          const otro = await this.periodo(comparar, t);
          comparado = {
            periodo: otro,
            estado: estadoDeResultados(
              await this.movimientos(otro.desde, otro.hasta, t, centro),
            ),
          };
        }

        // Los seis meses en una sola consulta: por mes y cuenta.
        const meses = mesesHasta(mes, 6);
        const desde = mesDe(meses[0]).desde;
        const delCentro = condicionCentro(centro, 3);
        const crudas = filas<{
          mes: string;
          codigo: string;
          nombre: string;
          debito: string;
          credito: string;
        }>(
          await t.query(
            `SELECT to_char(a.fecha, 'YYYY-MM') AS mes, c.codigo, c.nombre,
                  sum(l.debito) AS debito, sum(l.credito) AS credito
             ${LIBRO}
              AND a.fecha BETWEEN $1 AND $2
              AND c.codigo ~ '^[4-7]'
              ${delCentro.sql}
            GROUP BY 1, 2, 3`,
            [desde, periodo.hasta, ...delCentro.params],
          ),
        );
        const porMes = meses.map((m) => ({
          mes: m,
          utilidad: estadoDeResultados(
            crudas.filter((f) => f.mes === m).map(aMovimiento),
          ).utilidadAntesDeImpuestos,
        }));

        return {
          periodo,
          actual,
          comparado,
          margenes: {
            bruto: margen(actual.utilidadBruta, actual.ingresosOperacionales),
            operacional: margen(
              actual.utilidadOperacional,
              actual.ingresosOperacionales,
            ),
            antesDeImpuestos: margen(
              actual.utilidadAntesDeImpuestos,
              actual.ingresosOperacionales,
            ),
          },
          porMes,
        };
      },
      tx,
    );
  }

  async balance(
    ctx: CtxEmpresa,
    mes: string,
    comparar?: string,
    tx?: Tx,
  ): Promise<Balance> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const periodo = await this.periodo(mes, t);
        const actual = await this.balanceAl(periodo.corte, t);
        let comparado: Balance['comparado'] = null;
        if (comparar !== undefined) {
          const otro = await this.periodo(comparar, t);
          comparado = {
            periodo: otro,
            balance: await this.balanceAl(otro.corte, t),
          };
        }
        return { periodo, actual, comparado };
      },
      tx,
    );
  }

  async flujo(ctx: CtxEmpresa, mes: string, tx?: Tx): Promise<Flujo> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const periodo = await this.periodo(mes, t);
        const lineas = filas<{
          asiento_id: string;
          codigo: string;
          neto: string;
          concepto: string | null;
          tipo_flujo: Actividad | null;
        }>(
          await t.query(
            `WITH de_caja AS (
             SELECT DISTINCT l.asiento_id
               ${LIBRO}
                AND a.fecha BETWEEN $1 AND $2
                AND c.codigo LIKE '11%'
           )
           SELECT l.asiento_id, c.codigo, (l.debito - l.credito) AS neto,
                  k.nombre AS concepto, k.tipo_flujo
             FROM asiento_linea l
             JOIN de_caja d ON d.asiento_id = l.asiento_id
             JOIN empresa_cuenta c ON c.id = l.cuenta_id
             LEFT JOIN concepto_movimiento k ON k.id = l.concepto_id`,
            [periodo.desde, periodo.hasta],
          ),
        );
        const porAsiento = new Map<string, AsientoDeCaja>();
        for (const l of lineas) {
          const a = porAsiento.get(l.asiento_id) ?? {
            netoCaja: 0,
            contrapartidas: [],
          };
          const neto = Number(l.neto);
          if (l.codigo.startsWith('11')) a.netoCaja += neto;
          else
            a.contrapartidas.push({
              codigo: l.codigo,
              neto,
              concepto:
                l.concepto !== null && l.tipo_flujo !== null
                  ? { nombre: l.concepto, tipoFlujo: l.tipo_flujo }
                  : null,
            });
          porAsiento.set(l.asiento_id, a);
        }
        const inicial = await this.disponibleAl(periodo.desde, t, false);
        const final = await this.disponibleAl(periodo.hasta, t, true);
        return {
          periodo,
          directo: flujoDirecto([...porAsiento.values()], inicial, final),
        };
      },
      tx,
    );
  }

  /**
   * Lo que va a entrar y salir en las próximas semanas. Los pagos
   * programados que apuntan a una compra no se suman dos veces: la compra
   * ya está en lo que falta pagar.
   */
  async proyectado(ctx: CtxEmpresa, semanas: number): Promise<Proyectado> {
    const hoy = hoyEnColombia();
    const [disponible, porCobrar, porPagar, programados] = await Promise.all([
      this.tx.enContexto(ctx, (t) => this.disponibleAl(hoy, t, true)),
      this.ventas.pendientesPorCobrar(ctx),
      this.compras.pendientesPorPagar(ctx),
      this.compras.programadosPendientes(ctx),
    ]);
    return {
      hoy,
      disponible,
      semanas: flujoProyectado({
        hoy,
        disponible,
        porCobrar: porCobrar.map((x) => ({
          fecha: x.vence,
          valor: x.pendiente,
        })),
        porPagar: [
          ...porPagar.map((x) => ({ fecha: x.vence, valor: x.pendiente })),
          ...programados
            .filter((p) => p.compraId === null)
            .map((p) => ({ fecha: p.fecha, valor: p.valor })),
        ],
        semanas,
      }),
    };
  }

  /** El mes, su corte y cómo está su período contable. */
  private async periodo(mes: string, t: Tx): Promise<Periodo> {
    const { desde, hasta } = mesDe(mes);
    const hoy = hoyEnColombia();
    const [anio, n] = mes.split('-').map(Number);
    const p = fila<{ estado: string }>(
      await t.query(
        'SELECT estado FROM periodo_contable WHERE anio = $1 AND mes = $2',
        [anio, n],
      ),
    );
    const asientos = Number(
      fila<{ n: string }>(
        await t.query(
          `SELECT count(*) AS n FROM asiento WHERE estado = 'REGISTRADO' AND fecha BETWEEN $1 AND $2`,
          [desde, hasta],
        ),
      )?.n ?? 0,
    );
    return {
      mes,
      desde,
      hasta,
      corte: hoy >= desde && hoy <= hasta ? hoy : hasta,
      estado:
        p === undefined
          ? 'SIN_PERIODO'
          : p.estado === 'CERRADO'
            ? 'CERRADO'
            : 'ABIERTO',
      asientos,
    };
  }

  /** Débitos y créditos de las clases 4 a 7 del rango. */
  private async movimientos(
    desde: string,
    hasta: string,
    t: Tx,
    centro?: FiltroCentro,
  ): Promise<MovimientoCuenta[]> {
    const delCentro = condicionCentro(centro, 3);
    return filas<{
      codigo: string;
      nombre: string;
      debito: string;
      credito: string;
    }>(
      await t.query(
        `SELECT c.codigo, c.nombre, sum(l.debito) AS debito, sum(l.credito) AS credito
           ${LIBRO}
            AND a.fecha BETWEEN $1 AND $2
            AND c.codigo ~ '^[4-7]'
            ${delCentro.sql}
          GROUP BY c.codigo, c.nombre`,
        [desde, hasta, ...delCentro.params],
      ),
    ).map(aMovimiento);
  }

  /**
   * El estado de resultados del mes en columnas: una por centro de costo (o
   * por tipo de centro), «Sin centro» y el total. Sale de las líneas de
   * asiento, no de `saldo_cuenta_periodo`, que no tiene centro.
   */
  async resultadosPorCentro(
    ctx: CtxEmpresa,
    mes: string,
    agrupar: 'CENTRO' | 'TIPO',
  ): Promise<ResultadosPorCentro> {
    return this.tx.enContexto(ctx, async (t) => {
      const periodo = await this.periodo(mes, t);
      const movs = filas<{
        codigo: string;
        nombre: string;
        centro_id: string | null;
        debito: string;
        credito: string;
      }>(
        await t.query(
          `SELECT c.codigo, c.nombre, l.centro_costo_id AS centro_id,
                  sum(l.debito) AS debito, sum(l.credito) AS credito
             ${LIBRO}
              AND a.fecha BETWEEN $1 AND $2
              AND c.codigo ~ '^[4-7]'
            GROUP BY c.codigo, c.nombre, l.centro_costo_id`,
          [periodo.desde, periodo.hasta],
        ),
      ).map((f) => ({ ...aMovimiento(f), centroId: f.centro_id }));
      // Todos, activos o no: un centro desactivado sigue teniendo su historia.
      const centros = filas<CentroDeColumna>(
        await t.query(
          `SELECT id, codigo, nombre, tipo FROM empresa_centro_costo ORDER BY codigo`,
        ),
      );
      return {
        periodo,
        agrupar,
        ...resultadosPorCentro(movs, centros, agrupar),
      };
    });
  }

  /** El balance al corte: saldos de balance, y los resultados sin cerrar por año. */
  private async balanceAl(corte: string, t: Tx): Promise<BalanceGeneral> {
    const saldos = filas<{ codigo: string; nombre: string; saldo: string }>(
      await t.query(
        `SELECT c.codigo, c.nombre, sum(l.debito - l.credito) AS saldo
           ${LIBRO}
            AND a.fecha <= $1
          GROUP BY c.codigo, c.nombre
         HAVING sum(l.debito - l.credito) <> 0`,
        [corte],
      ),
    ).map((f): SaldoCuenta => ({
      codigo: f.codigo,
      nombre: f.nombre,
      saldo: Number(f.saldo),
    }));
    const inicioAnio = `${corte.slice(0, 4)}-01-01`;
    const deAnios = filas<{
      del_anio: boolean;
      codigo: string;
      nombre: string;
      saldo: string;
    }>(
      await t.query(
        `SELECT a.fecha >= $2 AS del_anio, c.codigo, c.nombre, sum(l.debito - l.credito) AS saldo
           ${LIBRO}
            AND a.fecha <= $1
            AND c.codigo ~ '^[4-7]'
          GROUP BY 1, 2, 3`,
        [corte, inicioAnio],
      ),
    );
    const resultado = (delAnio: boolean) =>
      resultadoDe(
        deAnios
          .filter((f) => f.del_anio === delAnio)
          .map((f) => ({
            codigo: f.codigo,
            nombre: f.nombre,
            saldo: Number(f.saldo),
          })),
      );
    return balanceGeneral(
      saldos.filter((s) => /^[1-3]/.test(s.codigo)),
      { ejercicio: resultado(true), anteriores: resultado(false) },
    );
  }

  /** Lo que había en caja y bancos (cuentas 11): al cierre del día, o antes de empezarlo. */
  private async disponibleAl(
    fecha: string,
    t: Tx,
    incluido: boolean,
  ): Promise<number> {
    return Number(
      fila<{ saldo: string | null }>(
        await t.query(
          `SELECT sum(l.debito - l.credito) AS saldo
             ${LIBRO}
              AND a.fecha ${incluido ? '<=' : '<'} $1
              AND c.codigo LIKE '11%'`,
          [fecha],
        ),
      )?.saldo ?? 0,
    );
  }
}

function aMovimiento(f: {
  codigo: string;
  nombre: string;
  debito: string;
  credito: string;
}): MovimientoCuenta {
  return {
    codigo: f.codigo,
    nombre: f.nombre,
    debito: Number(f.debito),
    credito: Number(f.credito),
  };
}
