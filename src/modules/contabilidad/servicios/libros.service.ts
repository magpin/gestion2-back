import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { mesAnterior } from './periodo.reglas';

export interface FilaBalance {
  cuenta_id: string;
  codigo: string;
  nombre: string;
  naturaleza: string;
  saldo_inicial: string;
  debitos: string;
  creditos: string;
  saldo_final: string;
}

export interface Movimiento {
  fecha: string;
  numero: string;
  glosa: string;
  detalle: string | null;
  tercero_nombre: string | null;
  debito: string;
  credito: string;
  /** Saldo acumulado hasta esta línea, incluida. */
  saldo: string;
}

/**
 * Los tres libros. Solo lectura, sin transacción.
 *
 * No son tablas: son consultas sobre `asiento_linea`. El diario ordena por
 * fecha, el mayor agrupa por cuenta y el auxiliar por tercero. Materializarlos
 * sería guardar tres copias de lo mismo que se desincronizan.
 *
 * Los tres excluyen los asientos anulados. Siguen en el libro y se pueden ver
 * pidiéndolos explícitamente en `/asientos`, pero no suman a ningún saldo.
 */
@Injectable()
export class LibrosService {
  constructor(private readonly tx: TxService) {}

  /**
   * Libro diario: los asientos de un rango, en orden cronológico, con sus líneas.
   *
   * Se trae en dos consultas y no con un JOIN: un JOIN devuelve la cabecera
   * repetida por cada línea, y un asiento de veinte líneas viaja veinte veces.
   */
  async diario(
    ctx: CtxEmpresa,
    desde: string,
    hasta: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, async (t) => {
      const asientos = filas<Record<string, unknown>>(
        await t.query(
          `SELECT a.id, a.numero, a.fecha, a.glosa, a.total_debito, a.total_credito,
                  c.codigo AS comprobante_codigo
             FROM asiento a
             JOIN empresa_comprobante_tipo c ON c.id = a.comprobante_tipo_id
            WHERE a.fecha BETWEEN $1 AND $2
              AND a.estado = 'REGISTRADO'
            ORDER BY a.fecha, a.numero`,
          [desde, hasta],
        ),
      );

      if (asientos.length === 0) {
        return [];
      }

      const ids = asientos.map((a) => a.id as string);
      const lineas = filas<Record<string, unknown>>(
        await t.query(
          `SELECT l.asiento_id, l.orden, l.debito, l.credito, l.detalle,
                  cu.codigo AS cuenta_codigo, cu.nombre AS cuenta_nombre,
                  coalesce(te.razon_social,
                           btrim(concat_ws(' ', te.primer_nombre, te.primer_apellido)))
                    AS tercero_nombre
             FROM asiento_linea l
             JOIN empresa_cuenta cu ON cu.id = l.cuenta_id
             LEFT JOIN tercero te ON te.id = l.tercero_id
            WHERE l.asiento_id = ANY($1)
            ORDER BY l.orden`,
          [ids],
        ),
      );

      const porAsiento = new Map<string, Array<Record<string, unknown>>>();
      for (const l of lineas) {
        const clave = l.asiento_id as string;
        const grupo = porAsiento.get(clave) ?? [];
        grupo.push(l);
        porAsiento.set(clave, grupo);
      }

      return asientos.map((a) => ({
        ...a,
        lineas: porAsiento.get(a.id as string) ?? [],
      }));
    });
  }

  /**
   * Libro mayor de una cuenta: sus movimientos con el saldo corrido.
   *
   * El saldo se acumula respetando la naturaleza —una cuenta de activo sube por
   * el débito, una de pasivo por el crédito—, para que se lea como un número
   * solo sin invertir el signo según la clase de cuenta.
   *
   * `SUM() OVER` lo calcula en la base. Hacerlo en TypeScript obligaría a traer
   * todas las líneas del año para mostrar las de un mes.
   */
  async mayor(
    ctx: CtxEmpresa,
    cuentaId: string,
    desde: string,
    hasta: string,
  ): Promise<{ cuenta: Record<string, unknown>; movimientos: Movimiento[] }> {
    return this.tx.enContexto(ctx, async (t) => {
      const cuenta = fila<Record<string, unknown>>(
        await t.query(
          'SELECT id, codigo, nombre, naturaleza FROM empresa_cuenta WHERE id = $1',
          [cuentaId],
        ),
      );

      if (cuenta === undefined) {
        throw new NotFoundException('Cuenta no encontrada');
      }

      const movimientos = filas<Movimiento>(
        await t.query(
          `SELECT a.fecha, a.numero, a.glosa, l.detalle, l.debito, l.credito,
                  coalesce(te.razon_social,
                           btrim(concat_ws(' ', te.primer_nombre, te.primer_apellido)))
                    AS tercero_nombre,
                  sum(CASE WHEN $4 = 'DEBITO' THEN l.debito - l.credito
                           ELSE l.credito - l.debito END)
                    OVER (ORDER BY a.fecha, a.numero, l.orden
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                    AS saldo
             FROM asiento_linea l
             JOIN asiento a ON a.id = l.asiento_id
             LEFT JOIN tercero te ON te.id = l.tercero_id
            WHERE l.cuenta_id = $1
              AND a.fecha BETWEEN $2 AND $3
              AND a.estado = 'REGISTRADO'
            ORDER BY a.fecha, a.numero, l.orden`,
          [cuentaId, desde, hasta, cuenta.naturaleza],
        ),
      );

      return { cuenta, movimientos };
    });
  }

  /**
   * El auxiliar de un tercero: de dónde sale la cartera.
   *
   * Agrupa por `asiento_linea.tercero_id`, no por una cuenta auxiliar por
   * cliente. Con cuatrocientos clientes, lo segundo hace ilegible el plan de
   * cuentas y llena el balance de prueba de renglones.
   */
  async auxiliarTercero(
    ctx: CtxEmpresa,
    terceroId: string,
    desde: string,
    hasta: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT a.fecha, a.numero, a.glosa, l.detalle, l.debito, l.credito,
                  cu.codigo AS cuenta_codigo, cu.nombre AS cuenta_nombre
             FROM asiento_linea l
             JOIN asiento a ON a.id = l.asiento_id
             JOIN empresa_cuenta cu ON cu.id = l.cuenta_id
            WHERE l.tercero_id = $1
              AND a.fecha BETWEEN $2 AND $3
              AND a.estado = 'REGISTRADO'
            ORDER BY a.fecha, a.numero, l.orden`,
          [terceroId, desde, hasta],
        ),
      ),
    );
  }

  /**
   * Balance de prueba de un período.
   *
   * Dos caminos, según el período esté cerrado o abierto:
   *
   *   CERRADO → lee `saldo_cuenta_periodo`. Es un SELECT plano, y es el número
   *             que se congeló ese día: el mismo que salió en los estados
   *             financieros que se entregaron.
   *   ABIERTO → suma sobre las líneas del mes y toma el saldo inicial del cierre
   *             del mes anterior. Es un solo mes, y ahí sí alcanza recorrerlo.
   *
   * El segundo camino existe porque el balance del mes en curso es justamente lo
   * que se mira todos los días, y no se puede pedir cerrar el mes para verlo.
   */
  async balancePrueba(
    ctx: CtxEmpresa,
    periodoId: string,
  ): Promise<{ periodo: Record<string, unknown>; filas: FilaBalance[] }> {
    return this.tx.enContexto(ctx, async (t) => {
      const periodo = fila<{
        id: string;
        anio: number;
        mes: number;
        estado: string;
      }>(
        await t.query(
          'SELECT id, anio, mes, estado FROM periodo_contable WHERE id = $1',
          [periodoId],
        ),
      );

      if (periodo === undefined) {
        throw new NotFoundException('Periodo no encontrado');
      }

      if (periodo.estado === 'CERRADO') {
        return {
          periodo,
          filas: filas<FilaBalance>(
            await t.query(
              `SELECT s.cuenta_id, c.codigo, c.nombre, c.naturaleza,
                      s.saldo_inicial, s.debitos, s.creditos, s.saldo_final
                 FROM saldo_cuenta_periodo s
                 JOIN empresa_cuenta c ON c.id = s.cuenta_id
                WHERE s.periodo_id = $1
                ORDER BY c.codigo`,
              [periodoId],
            ),
          ),
        };
      }

      const anterior = mesAnterior(periodo);

      return {
        periodo,
        filas: filas<FilaBalance>(
          await t.query(
            `SELECT c.id AS cuenta_id, c.codigo, c.nombre, c.naturaleza,
                    coalesce(previo.saldo_final, 0) AS saldo_inicial,
                    coalesce(mov.debitos, 0)  AS debitos,
                    coalesce(mov.creditos, 0) AS creditos,
                    coalesce(previo.saldo_final, 0)
                      + CASE WHEN c.naturaleza = 'DEBITO'
                             THEN coalesce(mov.debitos, 0) - coalesce(mov.creditos, 0)
                             ELSE coalesce(mov.creditos, 0) - coalesce(mov.debitos, 0)
                        END AS saldo_final
               FROM empresa_cuenta c
               LEFT JOIN (
                 SELECT l.cuenta_id,
                        sum(l.debito)  AS debitos,
                        sum(l.credito) AS creditos
                   FROM asiento_linea l
                   JOIN asiento a ON a.id = l.asiento_id
                  WHERE a.periodo_id = $1
                    AND a.estado = 'REGISTRADO'
                  GROUP BY l.cuenta_id
               ) mov ON mov.cuenta_id = c.id
               LEFT JOIN (
                 SELECT s.cuenta_id, s.saldo_final
                   FROM saldo_cuenta_periodo s
                   JOIN periodo_contable p ON p.id = s.periodo_id
                  WHERE p.anio = $2 AND p.mes = $3
               ) previo ON previo.cuenta_id = c.id
              WHERE c.empresa_id = $4
                AND c.es_auxiliar
                -- Las cuentas sin movimiento ni saldo no van: un balance con
                -- doscientos renglones en cero esconde los veinte que importan.
                AND (mov.cuenta_id IS NOT NULL OR coalesce(previo.saldo_final, 0) <> 0)
              ORDER BY c.codigo`,
            [periodoId, anterior.anio, anterior.mes, ctx.empresaId],
          ),
        ),
      };
    });
  }
}
