import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  armarResumen,
  sqlNombreMedio,
  type ResumenDelMes,
} from '../../../common/resumen-medio';
import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type {
  CrearReciboCajaDto,
  ListarRecibosCajaDto,
} from '../dto/recibo-caja.dto';
import {
  EDADES,
  diasVencidos,
  edadDe,
  numeroRecibo,
  validarRecibo,
  venceEfectivo,
  type EdadCartera,
} from './cartera.reglas';
import {
  CAMPOS_DOCUMENTO,
  VentaDocumentoService,
} from './venta-documento.service';

/** Una factura con saldo, como la ve quien cobra. */
export interface FacturaPorCobrar {
  id: string;
  numero: string;
  fecha: string;
  /** La pactada, o `null` si no hay: entonces vence a los 30 días. */
  vence: string | null;
  venceEfectivo: string;
  diasVencidos: number;
  edad: EdadCartera;
  pendiente: number;
}

/** Lo que un cliente debe, partido en por vencer y vencido. */
export interface ClientePorCobrar {
  terceroId: string;
  nombre: string;
  identificacion: string;
  facturas: number;
  porVencer: number;
  vencido: number;
  total: number;
  /** Los días de la factura más vencida; cero o negativo si nada vence. */
  maxDiasVencidos: number;
}

export interface Cartera {
  hoy: string;
  total: number;
  facturas: number;
  edades: Record<EdadCartera, number>;
  clientes: ClientePorCobrar[];
}

export interface ReciboCaja {
  id: string;
  numero: string;
  fecha: string;
  terceroId: string;
  terceroNombre: string;
  medio: 'CAJA' | 'BANCO';
  cajaId: string | null;
  cuentaBancariaId: string | null;
  /** El nombre de la caja o del banco. */
  destino: string;
  /** Lo que pagó el cliente en plata: abonos más anticipo. */
  total: number;
  /** Lo que se quedó el datáfono; entró `total − comision`. */
  comision: number;
  /** Lo que quedó como anticipo del cliente. */
  anticipo: number;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
  aplicaciones: Array<{
    facturaId: string;
    factura: string;
    valor: number;
    descuento: number;
  }>;
}

/** Clientes nacionales: la misma cuenta que usan la factura y el cobro. */
const CODIGO_CARTERA = '130505';

/** Las facturas vigentes con saldo, con los mismos campos que ve Ventas. */
const PENDIENTES = `
  SELECT * FROM (
    SELECT ${CAMPOS_DOCUMENTO}
      FROM venta_documento
     WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
  ) d
  WHERE d.pendiente > 0`;

const CAMPOS_RECIBO = `
  r.id, r.numero, r.fecha, r.tercero_id, r.medio, r.caja_id, r.cuenta_bancaria_id,
  r.total, r.comision, r.anticipo, r.estado, r.motivo_anulacion,
  (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))
     FROM tercero x WHERE x.id = r.tercero_id) AS tercero_nombre,
  COALESCE((SELECT c.nombre FROM caja c WHERE c.id = r.caja_id),
           (SELECT b.banco || ' ' || b.numero_cuenta FROM cuenta_bancaria b
             WHERE b.id = r.cuenta_bancaria_id)) AS destino,
  (SELECT coalesce(json_agg(json_build_object(
            'facturaId', a.venta_documento_id,
            'factura', v.prefijo || '-' || lpad(v.consecutivo::text, 6, '0'),
            'valor', a.valor, 'descuento', a.descuento) ORDER BY v.consecutivo), '[]'::json)
     FROM recibo_caja_aplicacion a
     JOIN venta_documento v ON v.id = a.venta_documento_id
    WHERE a.recibo_id = r.id) AS aplicaciones`;

/**
 * Cobros: lo que los clientes deben y el recibo de caja que lo salda.
 *
 * Vive en `ventas` y no en `tesoreria` porque cobrar es bajar la cartera de
 * una factura de venta, y `ventas` ya depende de `tesoreria` —no al revés—.
 * El recibo no inventa un camino: cada abono pasa por el cobro de siempre
 * (`VentaDocumentoService.cobrarEnTx`), que mueve la caja o el banco, asienta
 * y sube el `monto_pagado`. El recibo dice que esos cobros fueron un solo acto.
 */
@Injectable()
export class ReciboCajaService {
  constructor(
    private readonly tx: TxService,
    private readonly ventas: VentaDocumentoService,
    private readonly nucleo: NucleoApi,
    private readonly tesoreria: TesoreriaApi,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /** La cartera de hoy: por cliente, con las edades de lo vencido. */
  /**
   * Lo que falta cobrar, factura por factura, con cuándo vence: lo que el
   * flujo de caja proyectado pone en su semana.
   */
  async pendientesConVence(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<Array<{ vence: string; pendiente: number }>> {
    const facturas = await this.tx.enContexto(
      ctx,
      async (t) => filas<Record<string, unknown>>(await t.query(PENDIENTES)),
      tx,
    );
    return facturas.map((f) => ({
      vence: venceEfectivo(f.fecha as string, f.vence as string | null),
      pendiente: Number(f.pendiente),
    }));
  }

  async porCobrar(ctx: CtxEmpresa, tx?: Tx): Promise<Cartera> {
    const hoy = hoyEnColombia();
    const facturas = await this.tx.enContexto(
      ctx,
      async (t) => filas<Record<string, unknown>>(await t.query(PENDIENTES)),
      tx,
    );

    const edades = Object.fromEntries(EDADES.map((e) => [e, 0])) as Record<
      EdadCartera,
      number
    >;
    const porCliente = new Map<string, ClientePorCobrar>();
    let total = 0;

    for (const f of facturas) {
      const pendiente = Number(f.pendiente);
      const dias = diasVencidos(
        f.fecha as string,
        f.vence as string | null,
        hoy,
      );
      edades[edadDe(dias)] += pendiente;
      total += pendiente;

      const id = f.tercero_id as string;
      const cliente = porCliente.get(id) ?? {
        terceroId: id,
        nombre: f.tercero_nombre as string,
        identificacion: f.tercero_identificacion as string,
        facturas: 0,
        porVencer: 0,
        vencido: 0,
        total: 0,
        maxDiasVencidos: Number.NEGATIVE_INFINITY,
      };
      cliente.facturas += 1;
      cliente.total += pendiente;
      if (dias > 0) cliente.vencido += pendiente;
      else cliente.porVencer += pendiente;
      cliente.maxDiasVencidos = Math.max(cliente.maxDiasVencidos, dias);
      porCliente.set(id, cliente);
    }

    // Lo más vencido primero: es lo que hay que cobrar hoy.
    const clientes = [...porCliente.values()]
      .map((c) => ({
        ...c,
        porVencer: redondear(c.porVencer),
        vencido: redondear(c.vencido),
        total: redondear(c.total),
      }))
      .sort(
        (a, b) =>
          b.vencido - a.vencido ||
          b.maxDiasVencidos - a.maxDiasVencidos ||
          b.total - a.total,
      );

    return {
      hoy,
      total: redondear(total),
      facturas: facturas.length,
      edades: Object.fromEntries(
        EDADES.map((e) => [e, redondear(edades[e])]),
      ) as Record<EdadCartera, number>,
      clientes,
    };
  }

  /** Las facturas con saldo de un cliente, la más vieja primero: las que entran al recibo. */
  async facturasDe(
    ctx: CtxEmpresa,
    terceroId: string,
    tx?: Tx,
  ): Promise<FacturaPorCobrar[]> {
    const hoy = hoyEnColombia();
    const f = await this.tx.enContexto(
      ctx,
      async (t) =>
        filas<Record<string, unknown>>(
          await t.query(
            `${PENDIENTES} AND d.tercero_id = $1 ORDER BY d.fecha, d.consecutivo`,
            [terceroId],
          ),
        ),
      tx,
    );
    return f.map((x) => {
      const dias = diasVencidos(
        x.fecha as string,
        x.vence as string | null,
        hoy,
      );
      return {
        id: x.id as string,
        numero: `${x.prefijo as string}-${String(x.consecutivo).padStart(6, '0')}`,
        fecha: x.fecha as string,
        vence: x.vence as string | null,
        venceEfectivo: venceEfectivo(
          x.fecha as string,
          x.vence as string | null,
        ),
        diasVencidos: dias,
        edad: edadDe(dias),
        pendiente: Number(x.pendiente),
      };
    });
  }

  async listar(
    ctx: CtxEmpresa,
    q: ListarRecibosCajaDto = {},
  ): Promise<ReciboCaja[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const params: unknown[] = [];
      const condiciones: string[] = [];
      if (q.terceroId !== undefined) {
        params.push(q.terceroId);
        condiciones.push(`r.tercero_id = $${params.length}`);
      }
      if (q.mes !== undefined) {
        params.push(`${q.mes}-01`);
        condiciones.push(
          `r.fecha >= $${params.length}::date AND r.fecha < $${params.length}::date + interval '1 month'`,
        );
      }
      const donde =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;
      // Un mes entero se trae completo; sin mes, los últimos 200.
      const limite = q.mes === undefined ? 'LIMIT 200' : '';
      const f = filas<Record<string, unknown>>(
        await t.query(
          `SELECT ${CAMPOS_RECIBO} FROM recibo_caja r ${donde} ORDER BY r.numero DESC ${limite}`,
          params,
        ),
      );
      return f.map(aRecibo);
    });
  }

  /**
   * Lo cobrado en el mes por cada caja y cuenta (la cabecera de Recibos): lo
   * que pagaron los clientes, sin los anulados.
   */
  async resumen(ctx: CtxEmpresa, mes: string): Promise<ResumenDelMes> {
    return this.tx.enContexto(ctx, async (t) => {
      const f = filas<Parameters<typeof armarResumen>[1][number]>(
        await t.query(
          `SELECT r.medio, COALESCE(r.caja_id, r.cuenta_bancaria_id) AS id,
                  ${sqlNombreMedio('r.caja_id', 'r.cuenta_bancaria_id')},
                  sum(r.total) FILTER (WHERE r.estado = 'VIGENTE') AS total,
                  count(*) FILTER (WHERE r.estado = 'VIGENTE') AS cantidad,
                  count(*) FILTER (WHERE r.estado = 'ANULADO') AS anulados
             FROM recibo_caja r
            WHERE r.fecha >= $1::date AND r.fecha < $1::date + interval '1 month'
            GROUP BY r.medio, r.caja_id, r.cuenta_bancaria_id`,
          [`${mes}-01`],
        ),
      );
      return armarResumen(mes, f);
    });
  }

  async obtener(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<ReciboCaja> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS_RECIBO} FROM recibo_caja r WHERE r.id = $1`,
            [id],
          ),
        );
        if (f === undefined)
          throw new NotFoundException('Ese recibo no existe.');
        return aRecibo(f);
      },
      tx,
    );
  }

  /**
   * Registra el recibo, todo en una transacción —si algo no cabe, no entra
   * nada—:
   *   · cada abono, por el cobro de siempre de su factura;
   *   · cada descuento por pronto pago, con su asiento contra el gasto y sin
   *     que entre plata;
   *   · el anticipo, como un ingreso por concepto a nombre del cliente;
   *   · la comisión del datáfono, como un egreso por concepto del mismo medio.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: CrearReciboCajaDto,
    tx?: Tx,
  ): Promise<ReciboCaja> {
    const cuadre = validarRecibo(dto.aplicaciones, dto.anticipo, dto.comision);
    if (!cuadre.ok) throw new BadRequestException(cuadre.motivo);

    return this.tx.enContexto(
      ctx,
      async (t) => {
        if (dto.aplicaciones.length > 0) {
          const facturas = filas<{ id: string; tercero_id: string }>(
            await t.query(
              `SELECT id, tercero_id FROM venta_documento
                WHERE id = ANY($1::uuid[]) AND tipo = 'FACTURA'`,
              [dto.aplicaciones.map((a) => a.facturaId)],
            ),
          );
          if (facturas.length !== dto.aplicaciones.length) {
            throw new BadRequestException(
              'Alguna de las facturas no existe o no es una factura de venta.',
            );
          }
          if (facturas.some((f) => f.tercero_id !== dto.terceroId)) {
            throw new BadRequestException(
              'Un recibo es de un solo cliente: todas las facturas tienen que ser suyas.',
            );
          }
        }

        const numero = await this.siguienteNumero(ctx.empresaId, t);
        const recibo = fila<{ id: string }>(
          await t.query(
            `INSERT INTO recibo_caja
               (empresa_id, numero, fecha, tercero_id, medio, caja_id, cuenta_bancaria_id,
                total, comision, anticipo, creado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
              ctx.empresaId,
              numero,
              dto.fecha,
              dto.terceroId,
              dto.medio,
              dto.medio === 'CAJA' ? dto.cajaId : null,
              dto.medio === 'BANCO' ? dto.cuentaBancariaId : null,
              cuadre.total,
              dto.comision ?? 0,
              dto.anticipo ?? 0,
              ctx.usuarioId,
            ],
          ),
        );
        if (recibo === undefined) {
          throw new BadRequestException('No se pudo registrar el recibo.');
        }

        const referencia = numeroRecibo(numero);
        const medio = {
          medio: dto.medio,
          cajaId: dto.cajaId,
          cuentaBancariaId: dto.cuentaBancariaId,
        };

        for (const a of dto.aplicaciones) {
          if (a.valor > 0) {
            await this.ventas.cobrarEnTx(
              ctx,
              a.facturaId,
              { fecha: dto.fecha, pagos: [{ ...medio, valor: a.valor }] },
              t,
              referencia,
            );
          }
          let asientoDescuento: string | null = null;
          const descuento = a.descuento ?? 0;
          if (descuento > 0) {
            asientoDescuento = await this.asentarDescuento(
              ctx,
              {
                facturaId: a.facturaId,
                terceroId: dto.terceroId,
                fecha: dto.fecha,
                valor: descuento,
                referencia,
              },
              t,
            );
            await this.ventas.ajustarPagadoEnTx(ctx, a.facturaId, descuento, t);
          }
          await t.query(
            `INSERT INTO recibo_caja_aplicacion
               (empresa_id, recibo_id, venta_documento_id, valor, descuento, asiento_descuento_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              ctx.empresaId,
              recibo.id,
              a.facturaId,
              a.valor,
              descuento,
              asientoDescuento,
            ],
          );
        }

        if ((dto.anticipo ?? 0) > 0) {
          const concepto = await this.nucleo.conceptoPorCodigo(
            ctx,
            'NG-ANTICIPO-CLIENTE',
            t,
          );
          const anticipo = await this.tesoreria.registrarPorConcepto(
            ctx,
            {
              ...medio,
              direccion: 'ENTRADA',
              fecha: dto.fecha,
              conceptoId: concepto.id,
              terceroId: dto.terceroId,
              detalle: `${referencia} · Anticipo del cliente`,
              valorConcepto: dto.anticipo ?? 0,
              origen: 'RECIBO_CAJA',
              origenId: recibo.id,
            },
            t,
          );
          await t.query(
            'UPDATE recibo_caja SET anticipo_movimiento_id = $2 WHERE id = $1',
            [recibo.id, anticipo.id],
          );
        }

        if ((dto.comision ?? 0) > 0) {
          const concepto = await this.nucleo.conceptoPorCodigo(
            ctx,
            'GTO-COMISIONES',
            t,
          );
          const comision = await this.tesoreria.registrarPorConcepto(
            ctx,
            {
              ...medio,
              direccion: 'SALIDA',
              fecha: dto.fecha,
              conceptoId: concepto.id,
              detalle: `${referencia} · Comisión del datáfono o la pasarela`,
              valorConcepto: dto.comision ?? 0,
              origen: 'RECIBO_CAJA',
              origenId: recibo.id,
            },
            t,
          );
          await t.query(
            'UPDATE recibo_caja SET comision_movimiento_id = $2 WHERE id = $1',
            [recibo.id, comision.id],
          );
        }

        return this.obtener(ctx, recibo.id, t);
      },
      tx,
    );
  }

  /**
   * El descuento por pronto pago que se le concede al cliente: salda parte de
   * la factura sin que entre plata. Débito al gasto (el concepto
   * `GTO-DESCUENTO-PP`, 530535), crédito a Clientes con el cliente.
   */
  private async asentarDescuento(
    ctx: CtxEmpresa,
    datos: {
      facturaId: string;
      terceroId: string;
      fecha: string;
      valor: number;
      referencia: string;
    },
    t: Tx,
  ): Promise<string> {
    const concepto = await this.nucleo.conceptoPorCodigo(
      ctx,
      'GTO-DESCUENTO-PP',
      t,
    );
    if (concepto.cuenta === null) {
      throw new BadRequestException(
        'El concepto de descuentos por pronto pago no tiene cuenta: elegila en Contabilidad → Conceptos.',
      );
    }
    const cartera = await this.nucleo.cuenta(ctx, CODIGO_CARTERA, t);
    if (cartera === null) {
      throw new BadRequestException(
        `No existe o está inactiva la cuenta de cartera (${CODIGO_CARTERA}).`,
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
    const factura = fila<{ numero: string }>(
      await t.query(
        `SELECT prefijo || '-' || lpad(consecutivo::text, 6, '0') AS numero
           FROM venta_documento WHERE id = $1`,
        [datos.facturaId],
      ),
    );
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: datos.fecha,
        glosa: `${datos.referencia} · Descuento por pronto pago de la factura ${factura?.numero ?? ''}`,
        lineas: [
          {
            cuentaId: concepto.cuenta.id,
            debito: datos.valor,
            credito: 0,
            terceroId: datos.terceroId,
            conceptoId: concepto.id,
          },
          {
            cuentaId: cartera.id,
            debito: 0,
            credito: datos.valor,
            terceroId: datos.terceroId,
          },
        ],
      },
      { origenTipo: 'VENTA', origenId: datos.facturaId },
      t,
    );
    return asiento.id;
  }

  /**
   * Anula el recibo deshaciendo cada cosa por su camino: la comisión y el
   * anticipo con su movimiento contrario, cada descuento con su asiento
   * invertido, y cada cobro por la devolución de siempre —sale la plata del
   * mismo medio y la factura vuelve a deber lo abonado—. El recibo queda
   * anulado, con el motivo.
   */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<ReciboCaja> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const recibo = fila<{
          numero: number;
          estado: string;
          medio: 'CAJA' | 'BANCO';
          caja_id: string | null;
          cuenta_bancaria_id: string | null;
          anticipo_movimiento_id: string | null;
          comision_movimiento_id: string | null;
        }>(
          await t.query(
            `SELECT numero, estado, medio, caja_id, cuenta_bancaria_id,
                    anticipo_movimiento_id, comision_movimiento_id
               FROM recibo_caja WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (recibo === undefined)
          throw new NotFoundException('Ese recibo no existe.');
        if (recibo.estado === 'ANULADO') {
          throw new BadRequestException('Este recibo ya está anulado.');
        }
        const referencia = `Anulación ${numeroRecibo(recibo.numero)}`;

        // El anticipo no se puede anular si ya se aplicó a una factura: habría
        // que anular primero el cruce, que es otro documento.
        if (recibo.anticipo_movimiento_id !== null) {
          const cruces = fila<{ n: string }>(
            await t.query(
              `SELECT (SELECT count(*) FROM cruce_cartera
                         WHERE origen_movimiento_id = $1 AND estado = 'VIGENTE')
                    + (SELECT count(*) FROM movimiento_concepto
                        WHERE devuelve_a = $1 AND estado = 'VIGENTE') AS n`,
              [recibo.anticipo_movimiento_id],
            ),
          );
          if (Number(cruces?.n ?? 0) > 0) {
            throw new BadRequestException(
              'El anticipo de este recibo ya se aplicó a una factura o se devolvió: anulá primero ese cruce o esa devolución.',
            );
          }
          await this.tesoreria.anularPorConcepto(
            ctx,
            recibo.anticipo_movimiento_id,
            motivo,
            t,
          );
        }
        if (recibo.comision_movimiento_id !== null) {
          await this.tesoreria.anularPorConcepto(
            ctx,
            recibo.comision_movimiento_id,
            motivo,
            t,
          );
        }

        const aplicaciones = filas<{
          venta_documento_id: string;
          valor: string;
          descuento: string;
          asiento_descuento_id: string | null;
        }>(
          await t.query(
            `SELECT venta_documento_id, valor, descuento, asiento_descuento_id
               FROM recibo_caja_aplicacion WHERE recibo_id = $1`,
            [id],
          ),
        );
        const fecha = hoyEnColombia();
        for (const a of aplicaciones) {
          // Primero la devolución: mide lo cobrado en plata descontando lo que
          // saldó el descuento de este recibo, que todavía cuenta como vigente.
          if (Number(a.valor) > 0) {
            await this.ventas.devolverCobroEnTx(
              ctx,
              a.venta_documento_id,
              {
                fecha,
                pagos: [
                  {
                    medio: recibo.medio,
                    cajaId: recibo.caja_id ?? undefined,
                    cuentaBancariaId: recibo.cuenta_bancaria_id ?? undefined,
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
                facturaId: a.venta_documento_id,
              },
              t,
            );
            await this.ventas.ajustarPagadoEnTx(
              ctx,
              a.venta_documento_id,
              -Number(a.descuento),
              t,
            );
          }
        }

        await t.query(
          `UPDATE recibo_caja
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
    datos: { fecha: string; glosa: string; facturaId: string },
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
      { origenTipo: 'VENTA', origenId: datos.facturaId },
      t,
    );
    return asiento.id;
  }

  /** El siguiente número de recibo. `UPDATE … RETURNING` es el candado. */
  private async siguienteNumero(empresaId: string, t: Tx): Promise<number> {
    await t.query(
      `INSERT INTO recibo_caja_consecutivo (empresa_id) VALUES ($1)
       ON CONFLICT (empresa_id) DO NOTHING`,
      [empresaId],
    );
    const tomado = fila<{ consecutivo_actual: number }>(
      await t.query(
        `UPDATE recibo_caja_consecutivo SET consecutivo_actual = consecutivo_actual + 1
          WHERE empresa_id = $1 RETURNING consecutivo_actual`,
        [empresaId],
      ),
    );
    if (tomado === undefined)
      throw new BadRequestException('No se pudo numerar el recibo.');
    return Number(tomado.consecutivo_actual);
  }
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function aRecibo(f: Record<string, unknown>): ReciboCaja {
  return {
    id: f.id as string,
    numero: numeroRecibo(Number(f.numero)),
    fecha: f.fecha as string,
    terceroId: f.tercero_id as string,
    terceroNombre: f.tercero_nombre as string,
    medio: f.medio as 'CAJA' | 'BANCO',
    cajaId: (f.caja_id as string | null) ?? null,
    cuentaBancariaId: (f.cuenta_bancaria_id as string | null) ?? null,
    destino: (f.destino as string | null) ?? '',
    total: Number(f.total),
    comision: Number(f.comision ?? 0),
    anticipo: Number(f.anticipo ?? 0),
    estado: f.estado as 'VIGENTE' | 'ANULADO',
    motivoAnulacion: f.motivo_anulacion as string | null,
    aplicaciones: (
      f.aplicaciones as Array<{
        facturaId: string;
        factura: string;
        valor: string | number;
        descuento: string | number;
      }>
    ).map((a) => ({
      facturaId: a.facturaId,
      factura: a.factura,
      valor: Number(a.valor),
      descuento: Number(a.descuento),
    })),
  };
}
