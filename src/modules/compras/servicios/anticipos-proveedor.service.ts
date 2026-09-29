import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import { CAMPOS_DOCUMENTO } from './compra.service';
import { numeroComprobante } from './pagos.reglas';

export interface AnticipoAProveedor {
  movimientoId: string;
  terceroId: string;
  tercero: string;
  identificacion: string;
  /** El comprobante que lo pagó: «EG-000068». */
  comprobante: string | null;
  /** Para abrir el comprobante («Ver»). */
  comprobanteId: string | null;
  fecha: string;
  detalle: string;
  /** El anticipo bruto: lo que va a 133005. */
  anticipo: number;
  /** Lo que se le retuvo al darlo. */
  retenido: number;
  cruzado: number;
  devuelto: number;
  porLegalizar: number;
  /** Compras del proveedor por pagar: si hay, se legaliza con una de ellas. */
  comprasPendientes: number;
  /** La primera compra por pagar, para decir «Llegó la factura FC-771». */
  primeraCompra: string | null;
}

export interface DevolucionDeProveedor {
  id: string;
  anticipoId: string;
  tercero: string;
  fecha: string;
  valor: number;
  destino: string;
}

export interface AnticiposAProveedores {
  total: number;
  proveedores: number;
  anticipos: AnticipoAProveedor[];
  devoluciones: DevolucionDeProveedor[];
}

export interface DatosDevolucionProveedor {
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  fecha: string;
  /** La parte del anticipo bruto que se devuelve; entra ese valor menos su retención. */
  valor: number;
  motivo: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const NOMBRE = `COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))`;

/**
 * Pagos → Anticipos (Fase 5, PC19): la plata que ya se le dio a un proveedor
 * y todavía no tiene factura, de todos a la vez. Está en 133005 hasta que se
 * legalice (cruce con la compra) o el proveedor la devuelva.
 *
 * Si la devuelve, entra el neto y la retención que se le practicó al
 * anticipo se reversa en la misma proporción: ya no hubo pago que retener.
 */
@Injectable()
export class AnticiposProveedorService {
  constructor(
    private readonly tx: TxService,
    private readonly tesoreria: TesoreriaApi,
    private readonly retenciones: RetencionesApi,
  ) {}

  async pendientes(ctx: CtxEmpresa, tx?: Tx): Promise<AnticiposAProveedores> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipos = filas<Record<string, unknown>>(
          await t.query(
            `SELECT m.id, m.fecha::text AS fecha, m.detalle, m.tercero_id,
                    m.valor_concepto AS valor, m.valor_movido AS movido,
                    (SELECT ${NOMBRE} FROM tercero x WHERE x.id = m.tercero_id) AS tercero,
                    (SELECT x.numero_documento FROM tercero x WHERE x.id = m.tercero_id) AS identificacion,
                    (SELECT c.numero FROM comprobante_egreso c WHERE c.id = m.origen_id AND m.origen = 'COMPROBANTE_EGRESO') AS comprobante,
                    CASE WHEN m.origen = 'COMPROBANTE_EGRESO' THEN m.origen_id END AS comprobante_id,
                    (SELECT f.numero_factura_proveedor FROM (SELECT ${CAMPOS_DOCUMENTO} FROM compra_documento
                                            WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
                                              AND tercero_id = m.tercero_id) f
                      WHERE f.pendiente > 0 ORDER BY f.fecha, f.id LIMIT 1) AS primera_compra,
                    coalesce((SELECT sum(x.valor) FROM cruce_pago x
                               WHERE x.origen_movimiento_id = m.id AND x.estado = 'VIGENTE'), 0) AS cruzado,
                    coalesce((SELECT sum(d.valor_concepto) FROM movimiento_concepto d
                               WHERE d.devuelve_a = m.id AND d.estado = 'VIGENTE'), 0) AS devuelto,
                    (SELECT count(*) FROM (SELECT ${CAMPOS_DOCUMENTO} FROM compra_documento
                                            WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
                                              AND tercero_id = m.tercero_id) f
                      WHERE f.pendiente > 0) AS compras
               FROM movimiento_concepto m
               JOIN concepto_movimiento k ON k.id = m.concepto_id
              WHERE k.codigo = 'NG-ANTICIPO-PROVEEDOR' AND m.direccion = 'SALIDA'
                AND m.estado = 'VIGENTE'
              ORDER BY m.fecha DESC`,
          ),
        )
          .map((a) => {
            const anticipo = Number(a.valor);
            const cruzado = Number(a.cruzado);
            const devuelto = Number(a.devuelto);
            return {
              movimientoId: a.id as string,
              terceroId: a.tercero_id as string,
              tercero: (a.tercero as string | null) ?? 'Tercero sin nombre',
              identificacion: (a.identificacion as string | null) ?? '',
              comprobante:
                a.comprobante === null
                  ? null
                  : numeroComprobante(Number(a.comprobante)),
              comprobanteId: (a.comprobante_id as string | null) ?? null,
              fecha: a.fecha as string,
              detalle: a.detalle as string,
              anticipo,
              retenido: r2(anticipo - Number(a.movido)),
              cruzado,
              devuelto,
              porLegalizar: r2(anticipo - cruzado - devuelto),
              comprasPendientes: Number(a.compras),
              primeraCompra: (a.primera_compra as string | null) ?? null,
            };
          })
          .filter((a) => a.porLegalizar > 0);
        const devoluciones = filas<Record<string, unknown>>(
          await t.query(
            `SELECT d.id, d.devuelve_a, d.fecha::text AS fecha, d.valor_concepto AS valor,
                    (SELECT ${NOMBRE} FROM tercero x WHERE x.id = d.tercero_id) AS tercero,
                    COALESCE((SELECT k.nombre FROM caja k WHERE k.id = d.caja_id),
                             (SELECT b.banco FROM cuenta_bancaria b WHERE b.id = d.cuenta_bancaria_id)) AS destino
               FROM movimiento_concepto d
               JOIN concepto_movimiento k ON k.id = d.concepto_id
              WHERE k.codigo = 'NG-ANTICIPO-PROVEEDOR' AND d.origen = 'DEVOLUCION_ANTICIPO'
                AND d.estado = 'VIGENTE'
              ORDER BY d.creado_en DESC LIMIT 20`,
          ),
        ).map((d) => ({
          id: d.id as string,
          anticipoId: d.devuelve_a as string,
          tercero: (d.tercero as string | null) ?? '',
          fecha: d.fecha as string,
          valor: Number(d.valor),
          destino: (d.destino as string | null) ?? '',
        }));
        return {
          total: r2(anticipos.reduce((s, a) => s + a.porLegalizar, 0)),
          proveedores: new Set(anticipos.map((a) => a.terceroId)).size,
          anticipos,
          devoluciones,
        };
      },
      tx,
    );
  }

  /** El proveedor devuelve el anticipo, o una parte: entra el neto y se reversa su retención. */
  async devolver(
    ctx: CtxEmpresa,
    anticipoId: string,
    datos: DatosDevolucionProveedor,
    tx?: Tx,
  ) {
    if (datos.fecha > hoyEnColombia()) {
      throw new BadRequestException('La fecha no puede ser futura.');
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipo = fila<{
          tercero_id: string;
          concepto_id: string;
          origen_id: string | null;
          valor_concepto: string;
          fecha: string;
        }>(
          await t.query(
            `SELECT m.tercero_id, m.concepto_id, m.origen_id, m.valor_concepto, m.fecha::text AS fecha
               FROM movimiento_concepto m
               JOIN concepto_movimiento k ON k.id = m.concepto_id
              WHERE m.id = $1 AND k.codigo = 'NG-ANTICIPO-PROVEEDOR'
                AND m.direccion = 'SALIDA' AND m.estado = 'VIGENTE'
                FOR UPDATE OF m`,
            [anticipoId],
          ),
        );
        if (anticipo === undefined)
          throw new NotFoundException('Ese anticipo no existe.');
        if (datos.fecha < anticipo.fecha) {
          throw new BadRequestException(
            'La devolución no puede ser anterior al anticipo.',
          );
        }
        const saldo = (await this.pendientes(ctx, t)).anticipos.find(
          (a) => a.movimientoId === anticipoId,
        );
        if (saldo === undefined || datos.valor > saldo.porLegalizar + 0.004) {
          throw new BadRequestException(
            `Al anticipo le quedan ${saldo?.porLegalizar ?? 0} por legalizar: no se puede devolver más.`,
          );
        }
        // La referencia con la que se restablece la retención si se anula.
        const referencia = randomUUID();
        const reversada =
          anticipo.origen_id === null
            ? []
            : await this.retenciones.reversarAnticipo(
                ctx,
                {
                  anticipoId: anticipo.origen_id,
                  proporcion: datos.valor / Number(anticipo.valor_concepto),
                  fecha: datos.fecha,
                  texto:
                    'El proveedor devolvió el anticipo: no hubo pago que retener.',
                  cruceId: referencia,
                },
                t,
              );
        return this.tesoreria.registrarPorConcepto(
          ctx,
          {
            direccion: 'ENTRADA',
            medio: datos.medio,
            cajaId: datos.cajaId,
            cuentaBancariaId: datos.cuentaBancariaId,
            fecha: datos.fecha,
            conceptoId: anticipo.concepto_id,
            terceroId: anticipo.tercero_id,
            detalle: `Devolución de anticipo · ${datos.motivo.trim()}`,
            valorConcepto: r2(datos.valor),
            // En una entrada, la retención reversada va al débito (2365).
            retenciones: reversada.map((r) => ({
              cuentaId: r.cuentaId,
              base: r.base,
              valor: r.valor,
            })),
            origen: 'DEVOLUCION_ANTICIPO',
            origenId: referencia,
            devuelveA: anticipoId,
          },
          t,
        );
      },
      tx,
    );
  }

  /** Deshace la devolución: sale la plata y la retención vuelve a su lugar. */
  async anularDevolucion(ctx: CtxEmpresa, id: string, motivo: string, tx?: Tx) {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const d = fila<{ origen: string; origen_id: string | null }>(
          await t.query(
            'SELECT origen, origen_id FROM movimiento_concepto WHERE id = $1',
            [id],
          ),
        );
        if (d?.origen !== 'DEVOLUCION_ANTICIPO') {
          throw new NotFoundException('Esa devolución no existe.');
        }
        if (d.origen_id !== null) {
          await this.retenciones.restablecerAnticipo(
            ctx,
            {
              cruceId: d.origen_id,
              fecha: hoyEnColombia(),
              texto: `Anulación de la devolución del anticipo · ${motivo}`,
            },
            t,
          );
        }
        return this.tesoreria.anularPorConcepto(ctx, id, motivo, t);
      },
      tx,
    );
  }
}
