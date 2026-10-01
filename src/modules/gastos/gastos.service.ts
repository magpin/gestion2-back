import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { fila, filas } from '../../common/db/filas';
import { TxService, type Tx } from '../../common/db/tx.service';
import { NucleoApi } from '../nucleo/nucleo.api';
import {
  rangoMes,
  sugerirConcepto,
  variacion,
  type Sugerencia,
} from './gastos.reglas';

export interface GrupoGasto {
  grupo: string;
  total: number;
  /** Del total del mes, con un decimal. */
  porcentaje: number;
  conceptos: Array<{ id: string; nombre: string; total: number }>;
}

/** De dónde salió un gasto: lo que la pantalla muestra al lado del número. */
export type OrigenGasto =
  | 'COMPRA'
  | 'NOTA_COMPRA'
  | 'SIN_FACTURA'
  | 'GMF'
  | 'COMPROBANTE_EGRESO'
  | 'RECIBO_CAJA'
  | 'OTRO';

export interface GastoReciente {
  asientoId: string;
  fecha: string;
  concepto: string;
  tercero: string | null;
  documento: string;
  origen: OrigenGasto;
  valor: number;
}

export interface ResumenGastos {
  mes: string;
  total: number;
  registros: number;
  anterior: { mes: string; total: number };
  /** Frente al mes anterior, en porcentaje; `null` si ese mes no tuvo gastos. */
  variacion: number | null;
  grupos: GrupoGasto[];
  ultimos: GastoReciente[];
  /**
   * Cuánto se gastó en cada centro de costo, de mayor a menor; `id` en
   * `null` es lo que quedó sin centro. Vacío si nada lleva centro.
   */
  porCentro: Array<{ id: string | null; nombre: string; total: number }>;
}

const NOMBRE_TERCERO = `coalesce(nullif(btrim(t.razon_social), ''),
  concat_ws(' ', t.primer_nombre, t.segundo_nombre, t.primer_apellido, t.segundo_apellido))`;

/**
 * Las líneas de gasto del período: toda línea de asiento con un concepto de
 * gasto o costo, en un asiento registrado. Débito menos crédito: la reversa
 * de una anulación y la nota crédito restan solas, porque llevan el mismo
 * concepto que lo que corrigen.
 */
const LINEAS = `
  SELECT l.id, a.id AS asiento_id, a.numero AS asiento_numero, a.fecha, a.origen_tipo, a.origen_id,
         c.id AS concepto_id, c.nombre AS concepto, c.grupo, l.tercero_id,
         l.centro_costo_id,
         (l.debito - l.credito) AS valor
    FROM asiento_linea l
    JOIN asiento a ON a.id = l.asiento_id
    JOIN concepto_movimiento c ON c.id = l.concepto_id
   WHERE c.tipo IN ('GASTO', 'COSTO')
     AND a.estado = 'REGISTRADO'
     AND a.fecha >= $1 AND a.fecha < $2`;

/**
 * Egresos → Gastos. No tiene documento propio: lee lo que ya se registró por
 * concepto —las líneas de gasto de las compras, los pagos sin factura, el
 * 4×1000, las comisiones— y lo ordena por grupo. Solo lee.
 */
@Injectable()
export class GastosService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
  ) {}

  async resumen(ctx: CtxEmpresa, mes: string, tx?: Tx): Promise<ResumenGastos> {
    const { desde, hasta, anterior } = rangoMes(mes);
    const previo = rangoMes(anterior);
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const porConcepto = filas<{
          concepto_id: string;
          concepto: string;
          grupo: string;
          total: string;
          registros: string;
        }>(
          await t.query(
            `SELECT concepto_id, concepto, grupo, sum(valor) AS total, count(*) AS registros
             FROM (${LINEAS}) x
            GROUP BY concepto_id, concepto, grupo`,
            [desde, hasta],
          ),
        );
        const totalAnterior = Number(
          fila<{ total: string | null }>(
            await t.query(`SELECT sum(valor) AS total FROM (${LINEAS}) x`, [
              previo.desde,
              previo.hasta,
            ]),
          )?.total ?? 0,
        );

        const total = redondear(
          porConcepto.reduce((s, f) => s + Number(f.total), 0),
        );
        const grupos = new Map<string, GrupoGasto>();
        for (const f of porConcepto) {
          const valor = Number(f.total);
          if (valor === 0) continue;
          const g: GrupoGasto = grupos.get(f.grupo) ?? {
            grupo: f.grupo,
            total: 0,
            porcentaje: 0,
            conceptos: [],
          };
          g.total = redondear(g.total + valor);
          g.conceptos.push({
            id: f.concepto_id,
            nombre: f.concepto,
            total: valor,
          });
          grupos.set(f.grupo, g);
        }
        const lista = [...grupos.values()]
          .map((g) => ({
            ...g,
            porcentaje:
              total > 0 ? Math.round((g.total / total) * 1000) / 10 : 0,
            conceptos: g.conceptos.sort((a, b) => b.total - a.total),
          }))
          .sort((a, b) => b.total - a.total);

        const ultimos = filas<Record<string, unknown>>(
          await t.query(
            `SELECT x.asiento_id, x.asiento_numero, x.fecha::text AS fecha, x.concepto, x.valor,
                  cd.tipo AS compra_tipo, cd.numero_factura_proveedor,
                  m.origen AS movimiento_origen,
                  (SELECT ${NOMBRE_TERCERO} FROM tercero t
                    WHERE t.id = coalesce(x.tercero_id, cd.tercero_id, m.tercero_id)) AS tercero
             FROM (${LINEAS}) x
             LEFT JOIN compra_documento cd
                    ON x.origen_tipo = 'COMPRA' AND cd.id = x.origen_id
             LEFT JOIN movimiento_concepto m
                    ON x.origen_tipo IN ('MOVIMIENTO_CAJA', 'MOVIMIENTO_BANCO')
                   AND x.origen_id IN (m.caja_movimiento_id, m.banco_movimiento_id)
            ORDER BY x.fecha DESC, x.asiento_numero DESC
            LIMIT 30`,
            [desde, hasta],
          ),
        ).map(aReciente);

        const centros = filas<{
          id: string | null;
          nombre: string | null;
          total: string;
        }>(
          await t.query(
            `SELECT x.centro_costo_id AS id,
                    (SELECT cc.codigo || ' · ' || cc.nombre FROM empresa_centro_costo cc
                      WHERE cc.id = x.centro_costo_id) AS nombre,
                    sum(x.valor) AS total
               FROM (${LINEAS}) x
              GROUP BY x.centro_costo_id`,
            [desde, hasta],
          ),
        );
        // Sin ningún centro, no hay reparto que mostrar.
        const porCentro = centros.some((c) => c.id !== null)
          ? centros
              .map((c) => ({
                id: c.id,
                nombre: c.nombre ?? 'Sin centro',
                total: redondear(Number(c.total)),
              }))
              .filter((c) => c.total !== 0)
              .sort((a, b) => b.total - a.total)
          : [];

        return {
          mes,
          total,
          porCentro,
          registros: porConcepto.reduce((s, f) => s + Number(f.registros), 0),
          anterior: { mes: anterior, total: redondear(totalAnterior) },
          variacion: variacion(total, totalAnterior),
          grupos: lista,
          ultimos,
        };
      },
      tx,
    );
  }

  /**
   * Qué concepto sugiere María para un gasto: lo que ya se hizo con el
   * tercero y las pistas del catálogo. Sin modelo: es rápido y se puede
   * explicar. Lo confirma siempre una persona.
   */
  async sugerir(
    ctx: CtxEmpresa,
    descripcion: string,
    terceroId?: string,
    tx?: Tx,
  ): Promise<Sugerencia> {
    const conceptos = (await this.nucleo.conceptosActivos(ctx, tx)).filter(
      (c) =>
        c.activo &&
        !c.automatico &&
        c.cuenta !== null &&
        (c.tipo === 'GASTO' || c.tipo === 'COSTO'),
    );
    const historialTercero =
      terceroId === undefined
        ? []
        : await this.tx.enContexto(
            ctx,
            async (t) =>
              filas<{ concepto_id: string }>(
                await t.query(
                  `SELECT concepto_id FROM (
                   SELECT l.concepto_id, d.fecha, d.creado_en
                     FROM compra_documento_linea l
                     JOIN compra_documento d ON d.id = l.compra_documento_id
                    WHERE d.tercero_id = $1 AND d.tipo = 'FACTURA'
                      AND l.concepto_id IS NOT NULL
                   UNION ALL
                   SELECT m.concepto_id, m.fecha, m.creado_en
                     FROM movimiento_concepto m
                    WHERE m.tercero_id = $1 AND m.estado = 'VIGENTE' AND m.origen = 'MANUAL'
                 ) h
                 ORDER BY fecha DESC, creado_en DESC
                 LIMIT 10`,
                  [terceroId],
                ),
              ).map((f) => f.concepto_id),
            tx,
          );
    return sugerirConcepto({
      descripcion,
      conceptos: conceptos.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        pistas: c.pistas,
      })),
      historialTercero,
    });
  }
}

function aReciente(f: Record<string, unknown>): GastoReciente {
  const compraTipo = f.compra_tipo as string | null;
  const movimiento = f.movimiento_origen as string | null;
  const origen: OrigenGasto =
    compraTipo === 'FACTURA'
      ? 'COMPRA'
      : compraTipo !== null
        ? 'NOTA_COMPRA'
        : movimiento === 'MANUAL'
          ? 'SIN_FACTURA'
          : movimiento === 'GMF'
            ? 'GMF'
            : movimiento === 'COMPROBANTE_EGRESO'
              ? 'COMPROBANTE_EGRESO'
              : movimiento === 'RECIBO_CAJA'
                ? 'RECIBO_CAJA'
                : 'OTRO';
  return {
    asientoId: String(f.asiento_id),
    fecha: String(f.fecha),
    concepto: String(f.concepto),
    tercero: (f.tercero as string | null) ?? null,
    documento:
      (f.numero_factura_proveedor as string | null) ?? String(f.asiento_numero),
    origen,
    valor: Number(f.valor),
  };
}

function redondear(v: number): number {
  return Math.round(v * 100) / 100;
}
