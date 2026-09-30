import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import { numeroRecibo } from './cartera.reglas';
import { CAMPOS_DOCUMENTO } from './venta-documento.service';

export interface AnticipoDeCliente {
  movimientoId: string;
  terceroId: string;
  tercero: string;
  identificacion: string;
  /** El recibo que lo trajo: «RC-000229». */
  recibo: string | null;
  fecha: string;
  detalle: string;
  recibido: number;
  aplicado: number;
  devuelto: number;
  porAplicar: number;
  /** Facturas del cliente con saldo: si hay, se cruza; si no, se factura o se devuelve. */
  facturasPendientes: number;
}

/** Un anticipo con sus productos: con esto se llena la factura que lo aplica. */
export interface DetalleAnticipo extends AnticipoDeCliente {
  productos: Array<{
    productoId: string;
    nombre: string;
    cantidad: number;
    precioUnitario: number;
  }>;
}

export interface DevolucionAnticipo {
  id: string;
  anticipoId: string;
  tercero: string;
  fecha: string;
  valor: number;
  destino: string;
}

export interface AnticiposDeClientes {
  total: number;
  clientes: number;
  anticipos: AnticipoDeCliente[];
  /** Las últimas devoluciones vigentes, para poder deshacer una. */
  devoluciones: DevolucionAnticipo[];
}

/**
 * Lo que le quedó a favor a un cliente en una factura: una nota crédito que
 * cayó sobre una factura ya pagada (E1). La nota ya bajó su factura al
 * emitirse; esto es solo lo que sobra.
 */
export interface SaldoAFavorDeCliente {
  facturaId: string;
  factura: string;
  /** La nota crédito que lo dejó, si se encuentra. */
  nota: string | null;
  terceroId: string;
  tercero: string;
  fecha: string;
  saldo: number;
  /** Otras facturas del cliente con saldo: si hay, se cruza; si no, se devuelve. */
  facturasPendientes: number;
}

export interface SaldosAFavor {
  total: number;
  clientes: number;
  saldos: SaldoAFavorDeCliente[];
}

export interface DatosDevolucion {
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  fecha: string;
  valor: number;
  motivo: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const NOMBRE = `COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))`;

/**
 * Ingresos → Anticipos (Fase 5, PC19): la plata que dejaron los clientes y que
 * todavía no es venta, de todos a la vez, sin elegir primero al cliente. Está
 * en 280505 hasta que se cruce con una factura o se devuelva.
 *
 * Devolverla es el movimiento contrario del anticipo, con el mismo concepto:
 * sale de la caja o del banco (con su 4×1000) y baja el 280505 del cliente.
 */
@Injectable()
export class AnticiposClienteService {
  constructor(
    private readonly tx: TxService,
    private readonly tesoreria: TesoreriaApi,
  ) {}

  async pendientes(ctx: CtxEmpresa, tx?: Tx): Promise<AnticiposDeClientes> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipos = filas<Record<string, unknown>>(
          await t.query(
            `SELECT m.id, m.fecha::text AS fecha, m.detalle, m.tercero_id, m.valor_concepto AS valor,
                    (SELECT ${NOMBRE} FROM tercero x WHERE x.id = m.tercero_id) AS tercero,
                    (SELECT x.numero_documento FROM tercero x WHERE x.id = m.tercero_id) AS identificacion,
                    (SELECT r.numero FROM recibo_caja r WHERE r.id = m.origen_id AND m.origen = 'RECIBO_CAJA') AS recibo,
                    coalesce((SELECT sum(c.valor) FROM cruce_cartera c
                               WHERE c.origen_movimiento_id = m.id AND c.estado = 'VIGENTE'), 0) AS aplicado,
                    coalesce((SELECT sum(d.valor_concepto) FROM movimiento_concepto d
                               WHERE d.devuelve_a = m.id AND d.estado = 'VIGENTE'), 0) AS devuelto,
                    (SELECT count(*) FROM (SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
                                            WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
                                              AND tercero_id = m.tercero_id) f
                      WHERE f.pendiente > 0) AS facturas
               FROM movimiento_concepto m
               JOIN concepto_movimiento k ON k.id = m.concepto_id
              WHERE k.codigo = 'NG-ANTICIPO-CLIENTE' AND m.direccion = 'ENTRADA'
                AND m.estado = 'VIGENTE'
              ORDER BY m.fecha DESC`,
          ),
        )
          .map((a) => {
            const recibido = Number(a.valor);
            const aplicado = Number(a.aplicado);
            const devuelto = Number(a.devuelto);
            return {
              movimientoId: a.id as string,
              terceroId: a.tercero_id as string,
              tercero: (a.tercero as string | null) ?? 'Tercero sin nombre',
              identificacion: (a.identificacion as string | null) ?? '',
              recibo: a.recibo === null ? null : numeroRecibo(Number(a.recibo)),
              fecha: a.fecha as string,
              detalle: a.detalle as string,
              recibido,
              aplicado,
              devuelto,
              porAplicar: r2(recibido - aplicado - devuelto),
              facturasPendientes: Number(a.facturas),
            };
          })
          .filter((a) => a.porAplicar > 0);
        const devoluciones = filas<Record<string, unknown>>(
          await t.query(
            `SELECT d.id, d.devuelve_a, d.fecha::text AS fecha,
                    d.valor_concepto + coalesce((SELECT sum(g.valor_concepto) FROM movimiento_concepto g
                                                  WHERE g.origen_id = d.id AND g.origen = 'DEVOLUCION_ANTICIPO'
                                                    AND g.estado = 'VIGENTE'), 0) AS valor,
                    (SELECT ${NOMBRE} FROM tercero x WHERE x.id = d.tercero_id) AS tercero,
                    COALESCE((SELECT k.nombre FROM caja k WHERE k.id = d.caja_id),
                             (SELECT b.banco FROM cuenta_bancaria b WHERE b.id = d.cuenta_bancaria_id)) AS destino
               FROM movimiento_concepto d
               JOIN concepto_movimiento k ON k.id = d.concepto_id
              WHERE k.codigo = 'NG-ANTICIPO-CLIENTE' AND d.origen = 'DEVOLUCION_ANTICIPO'
                AND d.estado = 'VIGENTE' AND d.origen_id IS NULL
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
          total: r2(anticipos.reduce((s, a) => s + a.porAplicar, 0)),
          clientes: new Set(anticipos.map((a) => a.terceroId)).size,
          anticipos,
          devoluciones,
        };
      },
      tx,
    );
  }

  /** Los saldos a favor de todos los clientes (la pestaña Saldos a favor de Cobros). */
  async saldosAFavor(ctx: CtxEmpresa, tx?: Tx): Promise<SaldosAFavor> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const saldos = filas<Record<string, unknown>>(
          await t.query(
            `SELECT d.id, d.prefijo || '-' || lpad(d.consecutivo::text, 6, '0') AS factura,
                    d.tercero_id, d.fecha::text AS fecha, d.saldo_a_favor,
                    (SELECT ${NOMBRE} FROM tercero x WHERE x.id = d.tercero_id) AS tercero,
                    (SELECT n.prefijo || '-' || lpad(n.consecutivo::text, 6, '0')
                       FROM venta_documento n
                      WHERE n.documento_origen_id = d.id AND n.tipo = 'NOTA_CREDITO'
                        AND n.estado <> 'ANULADA'
                      ORDER BY n.fecha DESC LIMIT 1) AS nota,
                    (SELECT count(*) FROM (SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
                                            WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
                                              AND tercero_id = d.tercero_id) f
                      WHERE f.pendiente > 0 AND f.id <> d.id) AS facturas
               FROM (SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
                      WHERE tipo = 'FACTURA' AND estado = 'EMITIDA') d
              WHERE d.saldo_a_favor > 0
              ORDER BY d.fecha DESC`,
          ),
        ).map((s) => ({
          facturaId: s.id as string,
          factura: s.factura as string,
          nota: (s.nota as string | null) ?? null,
          terceroId: s.tercero_id as string,
          tercero: (s.tercero as string | null) ?? 'Tercero sin nombre',
          fecha: s.fecha as string,
          saldo: Number(s.saldo_a_favor),
          facturasPendientes: Number(s.facturas),
        }));
        return {
          total: r2(saldos.reduce((t2, s) => t2 + s.saldo, 0)),
          clientes: new Set(saldos.map((s) => s.terceroId)).size,
          saldos,
        };
      },
      tx,
    );
  }

  /** Un anticipo con lo que le queda y los productos para los que es. */
  async detalle(
    ctx: CtxEmpresa,
    movimientoId: string,
    tx?: Tx,
  ): Promise<DetalleAnticipo> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipo = (await this.pendientes(ctx, t)).anticipos.find(
          (a) => a.movimientoId === movimientoId,
        );
        if (anticipo === undefined) {
          throw new NotFoundException(
            'Ese anticipo no existe o ya no le queda nada por aplicar.',
          );
        }
        const productos = filas<{
          producto_id: string;
          nombre: string;
          cantidad: string;
          precio_unitario: string;
        }>(
          await t.query(
            `SELECT l.producto_id, p.nombre, l.cantidad, l.precio_unitario
               FROM movimiento_concepto m
               JOIN recibo_caja_anticipo_linea l ON l.recibo_id = m.origen_id
               JOIN producto p ON p.id = l.producto_id
              WHERE m.id = $1 AND m.origen = 'RECIBO_CAJA'
              ORDER BY l.orden`,
            [movimientoId],
          ),
        );
        return {
          ...anticipo,
          productos: productos.map((p) => ({
            productoId: p.producto_id,
            nombre: p.nombre,
            cantidad: Number(p.cantidad),
            precioUnitario: Number(p.precio_unitario),
          })),
        };
      },
      tx,
    );
  }

  /** Le devuelve al cliente lo que quede de su anticipo, o una parte. */
  async devolver(
    ctx: CtxEmpresa,
    anticipoId: string,
    datos: DatosDevolucion,
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
          fecha: string;
        }>(
          await t.query(
            `SELECT m.tercero_id, m.concepto_id, m.fecha::text AS fecha
               FROM movimiento_concepto m
               JOIN concepto_movimiento k ON k.id = m.concepto_id
              WHERE m.id = $1 AND k.codigo = 'NG-ANTICIPO-CLIENTE'
                AND m.direccion = 'ENTRADA' AND m.estado = 'VIGENTE'
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
        if (saldo === undefined || datos.valor > saldo.porAplicar + 0.004) {
          throw new BadRequestException(
            `Al anticipo le quedan ${saldo?.porAplicar ?? 0} por aplicar: no se puede devolver más.`,
          );
        }
        // Por banco, el 4×1000 lo asume el cliente (decisión del dueño, 30
        // sep): sale de su anticipo, no es gasto de la empresa. Del valor que
        // se devuelve, al cliente le llega lo que, sumado a su 4×1000, da ese
        // valor; el anticipo baja por el total.
        const gmf =
          datos.medio === 'BANCO' && datos.cuentaBancariaId
            ? await this.tesoreria.gmfIncluidoEn(
                ctx,
                datos.cuentaBancariaId,
                r2(datos.valor),
                t,
              )
            : 0;
        const movimiento = await this.tesoreria.registrarPorConcepto(
          ctx,
          {
            direccion: 'SALIDA',
            medio: datos.medio,
            cajaId: datos.cajaId,
            cuentaBancariaId: datos.cuentaBancariaId,
            fecha: datos.fecha,
            conceptoId: anticipo.concepto_id,
            terceroId: anticipo.tercero_id,
            detalle: `Devolución de anticipo · ${datos.motivo.trim()}`,
            valorConcepto: r2(datos.valor - gmf),
            origen: 'DEVOLUCION_ANTICIPO',
            devuelveA: anticipoId,
          },
          t,
        );
        if (gmf > 0) {
          await this.tesoreria.registrarPorConcepto(
            ctx,
            {
              direccion: 'SALIDA',
              medio: 'BANCO',
              cuentaBancariaId: datos.cuentaBancariaId,
              fecha: datos.fecha,
              conceptoId: anticipo.concepto_id,
              terceroId: anticipo.tercero_id,
              detalle:
                '4×1000 de la devolución del anticipo · lo asume el cliente',
              valorConcepto: gmf,
              origen: 'DEVOLUCION_ANTICIPO',
              origenId: movimiento.id,
              devuelveA: anticipoId,
            },
            t,
          );
        }
        return { ...movimiento, gmf };
      },
      tx,
    );
  }

  /** Deshace una devolución: la plata vuelve y el anticipo recupera su saldo. */
  async anularDevolucion(ctx: CtxEmpresa, id: string, motivo: string, tx?: Tx) {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const d = fila<{ origen: string }>(
          await t.query(
            'SELECT origen FROM movimiento_concepto WHERE id = $1',
            [id],
          ),
        );
        if (d?.origen !== 'DEVOLUCION_ANTICIPO') {
          throw new NotFoundException('Esa devolución no existe.');
        }
        // Con ella se anula el 4×1000 que asumió el cliente, que cuelga de
        // ella, y el que la empresa pagaba antes de ese cambio.
        const colgados = filas<{ id: string }>(
          await t.query(
            `SELECT id FROM movimiento_concepto
              WHERE origen_id = $1 AND origen IN ('DEVOLUCION_ANTICIPO', 'GMF')
                AND estado = 'VIGENTE'`,
            [id],
          ),
        );
        for (const c of colgados) {
          await this.tesoreria.anularPorConcepto(ctx, c.id, motivo, t);
        }
        return this.tesoreria.anularPorConcepto(ctx, id, motivo, t);
      },
      tx,
    );
  }
}
