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
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import { CAMPOS_DOCUMENTO, CompraService } from './compra.service';
import {
  TRAMOS,
  descuentoSugerido,
  numeroComprobante,
  tramoDe,
  validarComprobante,
  venceEfectivo,
  type AplicacionPago,
  type TramoPago,
} from './pagos.reglas';

/** Proveedores nacionales: la misma cuenta de la compra y del pago. */
const CODIGO_PROVEEDORES = '220505';

/** Una compra con saldo, como la ve quien paga. */
export interface CompraPorPagar {
  id: string;
  numero: string;
  fecha: string;
  vence: string | null;
  venceEfectivo: string;
  tramo: TramoPago;
  pendiente: number;
  /** Si todavía está en plazo, el descuento que el proveedor concede hoy. */
  descuentoSugerido: number;
  descuentoPct: number | null;
  descuentoHasta: string | null;
}

export interface ProveedorPorPagar {
  terceroId: string;
  nombre: string;
  identificacion: string;
  compras: CompraPorPagar[];
  total: number;
}

export interface PorPagar {
  hoy: string;
  total: number;
  compras: number;
  tramos: Record<TramoPago, number>;
  proveedores: ProveedorPorPagar[];
}

export interface ComprobanteEgreso {
  id: string;
  numero: string;
  fecha: string;
  terceroId: string;
  terceroNombre: string;
  medio: 'CAJA' | 'BANCO';
  destino: string;
  /** Lo que se le pagó en plata al proveedor. */
  total: number;
  /** El anticipo bruto que se le entregó. */
  anticipo: number;
  /** Lo que se le retuvo al anticipo. */
  retencionAnticipo: number;
  gmf: number;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
  aplicaciones: Array<{
    compraId: string;
    compra: string;
    valor: number;
    descuento: number;
  }>;
}

export interface DatosComprobante {
  terceroId: string;
  fecha: string;
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  aplicaciones: AplicacionPago[];
  /** El anticipo bruto que se le entrega; la retención la calcula el motor. */
  anticipo?: number;
  /** El concepto de retención del anticipo, si la persona lo eligió. */
  conceptoRetencionAnticipo?: string;
}

const PENDIENTES = `
  SELECT * FROM (
    SELECT ${CAMPOS_DOCUMENTO}
      FROM compra_documento
     WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
  ) d
  WHERE d.pendiente > 0`;

const CAMPOS_COMPROBANTE = `
  c.id, c.numero, c.fecha, c.tercero_id, c.medio, c.total, c.anticipo, c.gmf, c.estado,
  c.motivo_anulacion,
  (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))
     FROM tercero x WHERE x.id = c.tercero_id) AS tercero_nombre,
  COALESCE((SELECT k.nombre FROM caja k WHERE k.id = c.caja_id),
           (SELECT b.banco || ' ' || b.numero_cuenta FROM cuenta_bancaria b
             WHERE b.id = c.cuenta_bancaria_id)) AS destino,
  coalesce((SELECT m.valor_concepto - m.valor_movido FROM movimiento_concepto m
             WHERE m.id = c.anticipo_movimiento_id), 0) AS retencion_anticipo,
  (SELECT coalesce(json_agg(json_build_object(
            'compraId', a.compra_documento_id,
            'compra', d.numero_factura_proveedor,
            'valor', a.valor, 'descuento', a.descuento) ORDER BY d.fecha), '[]'::json)
     FROM comprobante_egreso_aplicacion a
     JOIN compra_documento d ON d.id = a.compra_documento_id
    WHERE a.comprobante_id = c.id) AS aplicaciones`;

/**
 * Pagos: lo que se le debe a los proveedores y el comprobante de egreso que
 * lo paga. Espejo de `ReciboCajaService`, y allá está el porqué de casi todo:
 * cada pago pasa por el de siempre (`CompraService.pagarEnTx`), y el
 * comprobante dice que fueron un solo acto.
 *
 * Lo propio de pagar:
 *   · el descuento por pronto pago obtenido, contra el ingreso 421040;
 *   · el 4×1000, si sale de un banco que no es exento;
 *   · el anticipo, con su retención calculada por el motor (D11b).
 */
@Injectable()
export class ComprobanteEgresoService {
  constructor(
    private readonly tx: TxService,
    private readonly compras: CompraService,
    private readonly nucleo: NucleoApi,
    private readonly tesoreria: TesoreriaApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly retenciones: RetencionesApi,
  ) {}

  /** Lo que se debe, por proveedor y por cuándo vence. */
  async porPagar(ctx: CtxEmpresa, tx?: Tx): Promise<PorPagar> {
    const hoy = hoyEnColombia();
    const filasCompra = await this.tx.enContexto(
      ctx,
      async (t) =>
        filas<Record<string, unknown>>(
          await t.query(`${PENDIENTES} ORDER BY d.fecha`),
        ),
      tx,
    );
    const tramos = Object.fromEntries(TRAMOS.map((x) => [x, 0])) as Record<
      TramoPago,
      number
    >;
    const porProveedor = new Map<string, ProveedorPorPagar>();
    let total = 0;
    for (const f of filasCompra) {
      const compra = aCompraPorPagar(f, hoy);
      tramos[compra.tramo] += compra.pendiente;
      total += compra.pendiente;
      const id = f.tercero_id as string;
      const p = porProveedor.get(id) ?? {
        terceroId: id,
        nombre: f.tercero_nombre as string,
        identificacion: f.tercero_identificacion as string,
        compras: [],
        total: 0,
      };
      p.compras.push(compra);
      p.total += compra.pendiente;
      porProveedor.set(id, p);
    }
    // Lo que vence primero, primero.
    const proveedores = [...porProveedor.values()]
      .map((p) => ({
        ...p,
        total: redondear(p.total),
        compras: p.compras.sort((a, b) =>
          a.venceEfectivo.localeCompare(b.venceEfectivo),
        ),
      }))
      .sort((a, b) =>
        a.compras[0].venceEfectivo.localeCompare(b.compras[0].venceEfectivo),
      );
    return {
      hoy,
      total: redondear(total),
      compras: filasCompra.length,
      tramos: Object.fromEntries(
        TRAMOS.map((x) => [x, redondear(tramos[x])]),
      ) as Record<TramoPago, number>,
      proveedores,
    };
  }

  /** Las compras con saldo de un proveedor, la que vence primero arriba. */
  async comprasDe(
    ctx: CtxEmpresa,
    terceroId: string,
    tx?: Tx,
  ): Promise<CompraPorPagar[]> {
    const hoy = hoyEnColombia();
    const f = await this.tx.enContexto(
      ctx,
      async (t) =>
        filas<Record<string, unknown>>(
          await t.query(`${PENDIENTES} AND d.tercero_id = $1`, [terceroId]),
        ),
      tx,
    );
    return f
      .map((x) => aCompraPorPagar(x, hoy))
      .sort((a, b) => a.venceEfectivo.localeCompare(b.venceEfectivo));
  }

  async listar(
    ctx: CtxEmpresa,
    terceroId?: string,
  ): Promise<ComprobanteEgreso[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const f = filas<Record<string, unknown>>(
        await t.query(
          `SELECT ${CAMPOS_COMPROBANTE} FROM comprobante_egreso c
            ${terceroId === undefined ? '' : 'WHERE c.tercero_id = $1'}
            ORDER BY c.numero DESC LIMIT 200`,
          terceroId === undefined ? [] : [terceroId],
        ),
      );
      return f.map(aComprobante);
    });
  }

  async obtener(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<ComprobanteEgreso> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS_COMPROBANTE} FROM comprobante_egreso c WHERE c.id = $1`,
            [id],
          ),
        );
        if (f === undefined)
          throw new NotFoundException('Ese comprobante no existe.');
        return aComprobante(f);
      },
      tx,
    );
  }

  /** Lo que el motor retendría del anticipo, sin guardar nada: para la pantalla. */
  proponerRetencionAnticipo(
    ctx: CtxEmpresa,
    datos: {
      terceroId: string;
      fecha: string;
      base: number;
      conceptoCodigo?: string;
    },
  ) {
    return this.retenciones.proponerAnticipo(ctx, {
      ...datos,
      texto: 'Anticipo a proveedor',
    });
  }

  /**
   * Registra el comprobante, todo o nada: cada pago por el de siempre, cada
   * descuento con su asiento, el anticipo con su retención y el 4×1000 de lo
   * que salió del banco.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: DatosComprobante,
    tx?: Tx,
  ): Promise<ComprobanteEgreso> {
    const validacion = validarComprobante(dto.aplicaciones, dto.anticipo);
    if (!validacion.ok) throw new BadRequestException(validacion.motivo);

    return this.tx.enContexto(
      ctx,
      async (t) => {
        if (dto.aplicaciones.length > 0) {
          const compras = filas<{ id: string; tercero_id: string }>(
            await t.query(
              `SELECT id, tercero_id FROM compra_documento
                WHERE id = ANY($1::uuid[]) AND tipo = 'FACTURA'`,
              [dto.aplicaciones.map((a) => a.compraId)],
            ),
          );
          if (compras.length !== dto.aplicaciones.length) {
            throw new BadRequestException(
              'Alguna de las compras no existe o no es una factura.',
            );
          }
          if (compras.some((c) => c.tercero_id !== dto.terceroId)) {
            throw new BadRequestException(
              'Un comprobante es de un solo proveedor: todas las compras tienen que ser suyas.',
            );
          }
        }

        // El id se decide antes: la retención del anticipo se guarda a nombre
        // del comprobante, y el comprobante se inserta cuando ya se sabe cuánto
        // salió en plata.
        const id = randomUUID();
        const numero = await this.siguienteNumero(ctx.empresaId, t);
        const referencia = numeroComprobante(numero);
        const medio = {
          medio: dto.medio,
          cajaId: dto.cajaId,
          cuentaBancariaId: dto.cuentaBancariaId,
        };

        const anticipoBruto = dto.anticipo ?? 0;
        const retencion =
          anticipoBruto > 0
            ? await this.retenciones.confirmarAnticipo(
                ctx,
                {
                  anticipoId: id,
                  terceroId: dto.terceroId,
                  fecha: dto.fecha,
                  base: anticipoBruto,
                  texto: 'Anticipo a proveedor',
                  conceptoCodigo: dto.conceptoRetencionAnticipo,
                },
                t,
              )
            : [];
        const retenido = retencion.reduce((s, r) => s + r.valor, 0);
        const abonado =
          dto.aplicaciones.reduce((s, a) => s + Math.round(a.valor * 100), 0) /
          100;
        const total = redondear(abonado + anticipoBruto - retenido);

        await t.query(
          `INSERT INTO comprobante_egreso
             (id, empresa_id, numero, fecha, tercero_id, medio, caja_id, cuenta_bancaria_id,
              total, anticipo, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            ctx.empresaId,
            numero,
            dto.fecha,
            dto.terceroId,
            dto.medio,
            dto.medio === 'CAJA' ? dto.cajaId : null,
            dto.medio === 'BANCO' ? dto.cuentaBancariaId : null,
            total,
            anticipoBruto,
            ctx.usuarioId,
          ],
        );

        for (const a of dto.aplicaciones) {
          if (a.valor > 0) {
            await this.compras.pagarEnTx(
              ctx,
              a.compraId,
              { fecha: dto.fecha, pagos: [{ ...medio, valor: a.valor }] },
              t,
              referencia,
            );
          }
          const descuento = a.descuento ?? 0;
          let asientoDescuento: string | null = null;
          if (descuento > 0) {
            asientoDescuento = await this.asentarDescuento(
              ctx,
              {
                compraId: a.compraId,
                terceroId: dto.terceroId,
                fecha: dto.fecha,
                valor: descuento,
                referencia,
              },
              t,
            );
            await this.compras.ajustarPagadoEnTx(ctx, a.compraId, descuento, t);
          }
          await t.query(
            `INSERT INTO comprobante_egreso_aplicacion
               (empresa_id, comprobante_id, compra_documento_id, valor, descuento, asiento_descuento_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              ctx.empresaId,
              id,
              a.compraId,
              a.valor,
              descuento,
              asientoDescuento,
            ],
          );
        }

        if (anticipoBruto > 0) {
          const concepto = await this.nucleo.conceptoPorCodigo(
            ctx,
            'NG-ANTICIPO-PROVEEDOR',
            t,
          );
          const movimiento = await this.tesoreria.registrarPorConcepto(
            ctx,
            {
              ...medio,
              direccion: 'SALIDA',
              fecha: dto.fecha,
              conceptoId: concepto.id,
              terceroId: dto.terceroId,
              detalle: `${referencia} · Anticipo al proveedor`,
              valorConcepto: anticipoBruto,
              retenciones: retencion.map((r) => ({
                cuentaId: r.cuentaId,
                valor: r.valor,
                base: r.base,
              })),
              origen: 'COMPROBANTE_EGRESO',
              origenId: id,
            },
            t,
          );
          await t.query(
            'UPDATE comprobante_egreso SET anticipo_movimiento_id = $2 WHERE id = $1',
            [id, movimiento.id],
          );
        }

        // El 4×1000 de todo lo que salió del banco en este comprobante.
        if (dto.medio === 'BANCO' && dto.cuentaBancariaId !== undefined) {
          const gmf = await this.tesoreria.cobrarGmf(
            ctx,
            {
              cuentaBancariaId: dto.cuentaBancariaId,
              base: total,
              fecha: dto.fecha,
              detalle: `${referencia} · 4×1000`,
              origenId: id,
            },
            t,
          );
          if (gmf !== null) {
            await t.query(
              'UPDATE comprobante_egreso SET gmf_movimiento_id = $2, gmf = $3 WHERE id = $1',
              [id, gmf.id, gmf.valorMovido],
            );
          }
        }

        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  /**
   * El descuento por pronto pago que concede el proveedor: salda parte de la
   * compra sin que salga plata. Débito a Proveedores, crédito al ingreso
   * (concepto `ING-DESCUENTO-PP`, 421040).
   */
  private async asentarDescuento(
    ctx: CtxEmpresa,
    datos: {
      compraId: string;
      terceroId: string;
      fecha: string;
      valor: number;
      referencia: string;
    },
    t: Tx,
  ): Promise<string> {
    const concepto = await this.nucleo.conceptoPorCodigo(
      ctx,
      'ING-DESCUENTO-PP',
      t,
    );
    const proveedores = await this.nucleo.cuenta(ctx, CODIGO_PROVEEDORES, t);
    if (concepto.cuenta === null || proveedores === null) {
      throw new BadRequestException(
        'Falta la cuenta de proveedores o la de descuentos obtenidos.',
      );
    }
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      'CD',
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de diario sembrado.',
      );
    }
    const compra = fila<{ numero: string }>(
      await t.query(
        'SELECT numero_factura_proveedor AS numero FROM compra_documento WHERE id = $1',
        [datos.compraId],
      ),
    );
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: datos.fecha,
        glosa: `${datos.referencia} · Descuento por pronto pago de la compra ${compra?.numero ?? ''}`,
        lineas: [
          {
            cuentaId: proveedores.id,
            debito: datos.valor,
            credito: 0,
            terceroId: datos.terceroId,
          },
          {
            cuentaId: concepto.cuenta.id,
            debito: 0,
            credito: datos.valor,
            terceroId: datos.terceroId,
            conceptoId: concepto.id,
          },
        ],
      },
      { origenTipo: 'COMPRA', origenId: datos.compraId },
      t,
    );
    return asiento.id;
  }

  /**
   * Anula el comprobante deshaciendo cada cosa por su camino. El anticipo no
   * se anula si ya se cruzó con una compra; su retención se reversa entera.
   */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<ComprobanteEgreso> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const c = fila<{
          numero: number;
          estado: string;
          medio: 'CAJA' | 'BANCO';
          caja_id: string | null;
          cuenta_bancaria_id: string | null;
          anticipo_movimiento_id: string | null;
          gmf_movimiento_id: string | null;
        }>(
          await t.query(
            `SELECT numero, estado, medio, caja_id, cuenta_bancaria_id, anticipo_movimiento_id,
                    gmf_movimiento_id
               FROM comprobante_egreso WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (c === undefined)
          throw new NotFoundException('Ese comprobante no existe.');
        if (c.estado === 'ANULADO')
          throw new BadRequestException('Este comprobante ya está anulado.');
        const referencia = `Anulación ${numeroComprobante(c.numero)}`;
        const fecha = hoyEnColombia();

        if (c.anticipo_movimiento_id !== null) {
          const cruces = fila<{ n: string }>(
            await t.query(
              `SELECT count(*) AS n FROM cruce_pago
                WHERE origen_movimiento_id = $1 AND estado = 'VIGENTE'`,
              [c.anticipo_movimiento_id],
            ),
          );
          if (Number(cruces?.n ?? 0) > 0) {
            throw new BadRequestException(
              'El anticipo de este comprobante ya se cruzó con una compra: anulá primero ese cruce.',
            );
          }
          // La retención deja de existir para la 350; el movimiento contrario
          // deshace su línea en 2365.
          await this.retenciones.reversarAnticipo(
            ctx,
            {
              anticipoId: id,
              proporcion: 1,
              fecha,
              texto: `${referencia} · ${motivo}`,
            },
            t,
          );
          await this.tesoreria.anularPorConcepto(
            ctx,
            c.anticipo_movimiento_id,
            motivo,
            t,
          );
        }
        if (c.gmf_movimiento_id !== null) {
          await this.tesoreria.anularPorConcepto(
            ctx,
            c.gmf_movimiento_id,
            motivo,
            t,
          );
        }

        const aplicaciones = filas<{
          compra_documento_id: string;
          valor: string;
          descuento: string;
          asiento_descuento_id: string | null;
        }>(
          await t.query(
            `SELECT compra_documento_id, valor, descuento, asiento_descuento_id
               FROM comprobante_egreso_aplicacion WHERE comprobante_id = $1`,
            [id],
          ),
        );
        for (const a of aplicaciones) {
          // Primero la devolución, que mide lo pagado en plata sin el descuento.
          if (Number(a.valor) > 0) {
            await this.compras.devolverPagoEnTx(
              ctx,
              a.compra_documento_id,
              {
                fecha,
                pagos: [
                  {
                    medio: c.medio,
                    cajaId: c.caja_id ?? undefined,
                    cuentaBancariaId: c.cuenta_bancaria_id ?? undefined,
                    valor: Number(a.valor),
                  },
                ],
              },
              t,
              referencia,
            );
          }
          if (a.asiento_descuento_id !== null) {
            await this.invertirAsiento(
              ctx,
              a.asiento_descuento_id,
              {
                fecha,
                glosa: `${referencia} · ${motivo}`,
                compraId: a.compra_documento_id,
              },
              t,
            );
            await this.compras.ajustarPagadoEnTx(
              ctx,
              a.compra_documento_id,
              -Number(a.descuento),
              t,
            );
          }
        }

        await t.query(
          `UPDATE comprobante_egreso
              SET estado = 'ANULADO', motivo_anulacion = $2, anulado_en = now(), anulado_por = $3
            WHERE id = $1`,
          [id, motivo.trim(), ctx.usuarioId],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  /** Un asiento al revés, con fecha de hoy: lo que deshace un descuento o un cruce. */
  async invertirAsiento(
    ctx: CtxEmpresa,
    asientoId: string,
    datos: { fecha: string; glosa: string; compraId: string },
    t: Tx,
  ): Promise<string> {
    const lineas = await this.contabilidad.lineasInvertidasDe(
      ctx,
      asientoId,
      t,
    );
    if (lineas === null) {
      throw new BadRequestException(
        'El asiento ya está anulado: no hay nada que deshacer.',
      );
    }
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      'CD',
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de diario sembrado.',
      );
    }
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: datos.fecha,
        glosa: datos.glosa,
        lineas,
      },
      { origenTipo: 'COMPRA', origenId: datos.compraId },
      t,
    );
    return asiento.id;
  }

  private async siguienteNumero(empresaId: string, t: Tx): Promise<number> {
    await t.query(
      `INSERT INTO comprobante_egreso_consecutivo (empresa_id) VALUES ($1)
       ON CONFLICT (empresa_id) DO NOTHING`,
      [empresaId],
    );
    const tomado = fila<{ consecutivo_actual: number }>(
      await t.query(
        `UPDATE comprobante_egreso_consecutivo SET consecutivo_actual = consecutivo_actual + 1
          WHERE empresa_id = $1 RETURNING consecutivo_actual`,
        [empresaId],
      ),
    );
    if (tomado === undefined)
      throw new BadRequestException('No se pudo numerar el comprobante.');
    return Number(tomado.consecutivo_actual);
  }
}

function redondear(v: number): number {
  return Math.round(v * 100) / 100;
}

function aCompraPorPagar(
  f: Record<string, unknown>,
  hoy: string,
): CompraPorPagar {
  const fecha = f.fecha as string;
  const vence = f.vence as string | null;
  const efectivo = venceEfectivo(fecha, vence);
  const pendiente = Number(f.pendiente);
  const pct = f.descuento_pp_pct === null ? null : Number(f.descuento_pp_pct);
  const hasta = f.descuento_pp_hasta as string | null;
  return {
    id: f.id as string,
    numero: f.numero_factura_proveedor as string,
    fecha,
    vence,
    venceEfectivo: efectivo,
    tramo: tramoDe(efectivo, hoy),
    pendiente,
    descuentoSugerido: descuentoSugerido(pendiente, pct, hasta, hoy),
    descuentoPct: pct,
    descuentoHasta: hasta,
  };
}

function aComprobante(f: Record<string, unknown>): ComprobanteEgreso {
  return {
    id: f.id as string,
    numero: numeroComprobante(Number(f.numero)),
    fecha: f.fecha as string,
    terceroId: f.tercero_id as string,
    terceroNombre: f.tercero_nombre as string,
    medio: f.medio as 'CAJA' | 'BANCO',
    destino: (f.destino as string | null) ?? '',
    total: Number(f.total),
    anticipo: Number(f.anticipo),
    retencionAnticipo: Number(f.retencion_anticipo),
    gmf: Number(f.gmf),
    estado: f.estado as 'VIGENTE' | 'ANULADO',
    motivoAnulacion: f.motivo_anulacion as string | null,
    aplicaciones: (
      f.aplicaciones as Array<{
        compraId: string;
        compra: string;
        valor: string | number;
        descuento: string | number;
      }>
    ).map((a) => ({
      compraId: a.compraId,
      compra: a.compra,
      valor: Number(a.valor),
      descuento: Number(a.descuento),
    })),
  };
}
