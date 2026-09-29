import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  armarResumen,
  sqlNombreMedio,
  type ResumenDelMes,
} from '../../../common/resumen-medio';
import { numeroComprobante } from './pagos.reglas';

export type TipoEgreso = 'PROVEEDOR' | 'SIN_FACTURA' | 'NO_GASTO' | 'IMPUESTO';

export interface Egreso {
  id: string;
  /** De dónde sale: el comprobante de egreso, un pago por concepto o una declaración. */
  origen: 'COMPROBANTE' | 'CONCEPTO' | 'DECLARACION' | 'CUOTA';
  /** El número que la persona reconoce: «EG-000074» o el del asiento. */
  numero: string;
  fecha: string;
  tercero: string | null;
  /** «FC-88213 · con descuento», «Nómina por pagar», «Retención · agosto · 490 …». */
  detalle: string;
  tipo: TipoEgreso;
  medio: 'CAJA' | 'BANCO';
  medioId: string;
  /** El nombre de la caja o del banco. */
  destino: string;
  /** Lo que salió, sin el 4×1000. */
  valor: number;
  gmf: number;
  estado: 'VIGENTE' | 'ANULADO';
}

export interface EgresosDelMes {
  resumen: ResumenDelMes;
  egresos: Egreso[];
}

const OBLIGACION = `CASE d.obligacion
    WHEN 'RETENCION' THEN 'Retención en la fuente'
    WHEN 'IVA' THEN 'IVA'
    WHEN 'RETEICA' THEN 'ReteICA'
    WHEN 'ICA' THEN 'ICA'
    ELSE 'Renta' END`;

/**
 * Pagos → Comprobantes (Fase 5, PC12): **todo lo que salió** en el mes, con
 * un filtro por tipo. El comprobante de egreso cubre los pagos a
 * proveedores; lo que se paga por concepto (sin factura) y las declaraciones
 * salen por tesorería con su propio asiento, y aquí se leen juntos.
 *
 * El 4×1000 no es una fila: va con el pago que lo causó (E27).
 */
@Injectable()
export class EgresosService {
  constructor(private readonly tx: TxService) {}

  async delMes(ctx: CtxEmpresa, mes: string, tx?: Tx): Promise<EgresosDelMes> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const desde = `${mes}-01`;
        const f = filas<Record<string, unknown>>(
          await t.query(
            `WITH gmf AS (
             SELECT origen_id, sum(valor_movido) AS valor
               FROM movimiento_concepto
              WHERE origen = 'GMF' AND estado = 'VIGENTE'
              GROUP BY origen_id
           ),
           filas AS (
             -- Los comprobantes de egreso: pagos a proveedores y anticipos.
             SELECT c.id, 'COMPROBANTE' AS origen, c.numero::text AS numero, c.fecha,
                    (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))
                       FROM tercero x WHERE x.id = c.tercero_id) AS tercero,
                    concat_ws(' · ',
                      (SELECT string_agg(d.numero_factura_proveedor, ', ' ORDER BY d.fecha)
                         FROM comprobante_egreso_aplicacion a
                         JOIN compra_documento d ON d.id = a.compra_documento_id
                        WHERE a.comprobante_id = c.id),
                      CASE WHEN c.anticipo > 0 THEN 'anticipo' END) AS detalle,
                    'PROVEEDOR' AS tipo, c.medio, c.caja_id, c.cuenta_bancaria_id,
                    -- total ya es lo que salió: abonos más el neto del anticipo.
                    c.total AS valor,
                    c.gmf, c.estado
               FROM comprobante_egreso c
              WHERE c.fecha >= $1::date AND c.fecha < $1::date + interval '1 month'
             UNION ALL
             -- Lo que se pagó por concepto a mano (sin factura o que no es gasto) y
             -- las devoluciones de anticipos a clientes.
             SELECT m.id, 'CONCEPTO', a.numero, m.fecha,
                    (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))
                       FROM tercero x WHERE x.id = m.tercero_id),
                    m.detalle || ' · ' || COALESCE(
                      (SELECT string_agg(k2.nombre, ' + ' ORDER BY l.orden)
                         FROM movimiento_concepto_linea l
                         JOIN concepto_movimiento k2 ON k2.id = l.concepto_id
                        WHERE l.movimiento_id = m.id),
                      cm.nombre),
                    CASE WHEN cm.tipo = 'NO_GASTO' THEN 'NO_GASTO' ELSE 'SIN_FACTURA' END,
                    m.medio, m.caja_id, m.cuenta_bancaria_id, m.valor_movido,
                    coalesce(g.valor, 0), m.estado
               FROM movimiento_concepto m
               JOIN concepto_movimiento cm ON cm.id = m.concepto_id
               LEFT JOIN asiento a ON a.id = m.asiento_id
               LEFT JOIN gmf g ON g.origen_id = m.id
              WHERE m.direccion = 'SALIDA' AND m.origen IN ('MANUAL', 'DEVOLUCION_ANTICIPO')
                AND m.fecha >= $1::date AND m.fecha < $1::date + interval '1 month'
             UNION ALL
             -- Las declaraciones pagadas de una vez.
             SELECT d.id, 'DECLARACION', a.numero, d.pagada_el,
                    CASE WHEN d.municipio_codigo IS NULL THEN 'DIAN'
                         ELSE 'Municipio de ' || (SELECT mu.nombre FROM municipio mu WHERE mu.codigo = d.municipio_codigo) END,
                    ${OBLIGACION} || ' ' || d.periodo || ' · recibo ' || d.recibo_490,
                    'IMPUESTO', d.medio, d.caja_id, d.cuenta_bancaria_id,
                    d.valor_a_pagar + d.intereses, d.gmf, 'VIGENTE'
               FROM declaracion d
               LEFT JOIN asiento a ON a.id = d.asiento_id
              WHERE d.estado = 'PAGADA' AND d.cuotas = 1
                AND d.pagada_el >= $1::date AND d.pagada_el < $1::date + interval '1 month'
             UNION ALL
             -- Las cuotas de la renta.
             SELECT p.id, 'CUOTA', a.numero, p.pagada_el, 'DIAN',
                    'Renta ' || d.periodo || ' · cuota ' || p.cuota || ' · recibo ' || p.recibo_490,
                    'IMPUESTO', p.medio, p.caja_id, p.cuenta_bancaria_id,
                    p.valor + p.intereses, p.gmf, 'VIGENTE'
               FROM declaracion_pago p
               JOIN declaracion d ON d.id = p.declaracion_id
               LEFT JOIN asiento a ON a.id = p.asiento_id
              WHERE p.pagada_el >= $1::date AND p.pagada_el < $1::date + interval '1 month'
           )
           SELECT f.*, f.fecha::text AS dia,
                  COALESCE(f.caja_id, f.cuenta_bancaria_id) AS medio_id,
                  ${sqlNombreMedio('f.caja_id', 'f.cuenta_bancaria_id', 'medio_')}
             FROM filas f
            ORDER BY f.fecha DESC, f.numero DESC`,
            [desde],
          ),
        );
        const egresos: Egreso[] = f.map((x) => ({
          id: x.id as string,
          origen: x.origen as Egreso['origen'],
          numero:
            x.origen === 'COMPROBANTE'
              ? numeroComprobante(Number(x.numero))
              : ((x.numero as string | null) ?? '—'),
          fecha: x.dia as string,
          tercero: (x.tercero as string | null) ?? null,
          detalle: (x.detalle as string | null) ?? '',
          tipo: x.tipo as TipoEgreso,
          medio: x.medio as 'CAJA' | 'BANCO',
          medioId: x.medio_id as string,
          destino: (x.medio_nombre as string | null) ?? '',
          valor: Number(x.valor),
          gmf: Number(x.gmf ?? 0),
          estado: x.estado as 'VIGENTE' | 'ANULADO',
        }));
        return { resumen: resumirEgresos(mes, egresos, f), egresos };
      },
      tx,
    );
  }
}

/** El resumen por medio: lo que salió de cada caja y cuenta, con su 4×1000. */
function resumirEgresos(
  mes: string,
  egresos: Egreso[],
  crudas: Array<Record<string, unknown>>,
): ResumenDelMes {
  const porMedio = new Map<
    string,
    Parameters<typeof armarResumen>[1][number]
  >();
  egresos.forEach((e, i) => {
    const m = porMedio.get(e.medioId) ?? {
      medio: e.medio,
      id: e.medioId,
      nombre: e.destino,
      detalle: (crudas[i].medio_detalle as string | null) ?? null,
      total: 0,
      cantidad: 0,
      anulados: 0,
    };
    if (e.estado === 'VIGENTE') {
      m.total = Number(m.total) + e.valor + e.gmf;
      m.cantidad = Number(m.cantidad) + 1;
    } else {
      m.anulados = Number(m.anulados) + 1;
    }
    porMedio.set(e.medioId, m);
  });
  return armarResumen(mes, [...porMedio.values()]);
}
