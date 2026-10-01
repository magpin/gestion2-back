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
import { ReciboCajaService } from './recibo-caja.service';
import {
  CAMPOS_DOCUMENTO,
  VentaDocumentoService,
} from './venta-documento.service';

const CODIGO_CARTERA = '130505';

/** Un anticipo del cliente con lo que le queda por aplicar. */
export interface AnticipoCliente {
  movimientoId: string;
  fecha: string;
  detalle: string;
  valor: number;
  aplicado: number;
  saldo: number;
}

/** Una factura del cliente que quedó con plata a su favor (una nota crédito después de cobrada). */
export interface SaldoAFavor {
  facturaId: string;
  factura: string;
  saldo: number;
}

export interface CruceCartera {
  id: string;
  tipo: 'ANTICIPO' | 'SALDO_A_FAVOR';
  terceroId: string;
  terceroNombre: string;
  origen: string;
  destinoFacturaId: string;
  destino: string;
  valor: number;
  fecha: string;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
}

const CAMPOS_CRUCE = `
  x.id, x.tipo, x.tercero_id, x.destino_venta_id, x.valor, x.fecha, x.estado, x.motivo_anulacion,
  (SELECT COALESCE(t.razon_social, concat_ws(' ', t.primer_nombre, t.primer_apellido))
     FROM tercero t WHERE t.id = x.tercero_id) AS tercero_nombre,
  COALESCE((SELECT m.detalle FROM movimiento_concepto m WHERE m.id = x.origen_movimiento_id),
           (SELECT v.prefijo || '-' || lpad(v.consecutivo::text, 6, '0')
              FROM venta_documento v WHERE v.id = x.origen_venta_id)) AS origen,
  (SELECT v.prefijo || '-' || lpad(v.consecutivo::text, 6, '0')
     FROM venta_documento v WHERE v.id = x.destino_venta_id) AS destino`;

/**
 * Cruces de cartera: aplicar a una factura lo que el cliente ya pagó por otro
 * lado —un anticipo, o el saldo a favor que le dejó una nota crédito en otra
 * factura—. No entra ni sale plata: solo cambia a qué factura se le abona.
 */
/** Un anticipo o saldo a favor que se aplica al emitir la factura. */
export interface AplicarAlFacturar {
  tipo: 'ANTICIPO' | 'SALDO_A_FAVOR';
  /** El movimiento del anticipo, o la factura con saldo a favor. */
  origenId: string;
  valor: number;
}

@Injectable()
export class CruceCarteraService {
  constructor(
    private readonly tx: TxService,
    private readonly ventas: VentaDocumentoService,
    private readonly recibos: ReciboCajaService,
    private readonly nucleo: NucleoApi,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /** Lo que un cliente tiene para aplicar: sus anticipos con saldo y sus saldos a favor. */
  async disponiblesDe(
    ctx: CtxEmpresa,
    terceroId: string,
    tx?: Tx,
  ): Promise<{ anticipos: AnticipoCliente[]; saldosAFavor: SaldoAFavor[] }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipos = filas<{
          id: string;
          fecha: string;
          detalle: string;
          valor: string;
          aplicado: string;
        }>(
          await t.query(
            `SELECT m.id, m.fecha, m.detalle, m.valor_concepto AS valor,
                    coalesce((SELECT sum(x.valor) FROM cruce_cartera x
                               WHERE x.origen_movimiento_id = m.id AND x.estado = 'VIGENTE'), 0)
                    -- Lo devuelto también baja el anticipo (PC19).
                    + coalesce((SELECT sum(d.valor_concepto) FROM movimiento_concepto d
                                 WHERE d.devuelve_a = m.id AND d.estado = 'VIGENTE'), 0)
                      AS aplicado
               FROM movimiento_concepto m
               JOIN concepto_movimiento c ON c.id = m.concepto_id
              WHERE c.codigo = 'NG-ANTICIPO-CLIENTE' AND m.tercero_id = $1
                AND m.estado = 'VIGENTE' AND m.direccion = 'ENTRADA'
              ORDER BY m.fecha`,
            [terceroId],
          ),
        )
          .map((a) => ({
            movimientoId: a.id,
            fecha: a.fecha,
            detalle: a.detalle,
            valor: Number(a.valor),
            aplicado: Number(a.aplicado),
            saldo:
              Math.round((Number(a.valor) - Number(a.aplicado)) * 100) / 100,
          }))
          .filter((a) => a.saldo > 0);

        const saldosAFavor = filas<{
          id: string;
          numero: string;
          saldo_a_favor: string;
        }>(
          await t.query(
            `SELECT d.id, d.prefijo || '-' || lpad(d.consecutivo::text, 6, '0') AS numero,
                    d.saldo_a_favor
               FROM (SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
                      WHERE tipo = 'FACTURA' AND estado = 'EMITIDA' AND tercero_id = $1) d
              WHERE d.saldo_a_favor > 0
              ORDER BY d.fecha`,
            [terceroId],
          ),
        ).map((f) => ({
          facturaId: f.id,
          factura: f.numero,
          saldo: Number(f.saldo_a_favor),
        }));

        return { anticipos, saldosAFavor };
      },
      tx,
    );
  }

  async listar(ctx: CtxEmpresa, terceroId?: string): Promise<CruceCartera[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const f = filas<Record<string, unknown>>(
        await t.query(
          `SELECT ${CAMPOS_CRUCE} FROM cruce_cartera x
            ${terceroId === undefined ? '' : 'WHERE x.tercero_id = $1'}
            ORDER BY x.fecha DESC, x.creado_en DESC LIMIT 200`,
          terceroId === undefined ? [] : [terceroId],
        ),
      );
      return f.map(aCruce);
    });
  }

  /**
   * Lo que se quiere aplicar al emitir una factura, contra lo que el cliente
   * tiene: cada anticipo o saldo a favor suyo, una sola vez y sin pasarse de
   * lo que le queda.
   */
  async validarAlFacturar(
    ctx: CtxEmpresa,
    terceroId: string,
    aplicar: readonly AplicarAlFacturar[],
    t: Tx,
  ): Promise<void> {
    if (aplicar.length === 0) return;
    const disponibles = await this.disponiblesDe(ctx, terceroId, t);
    const vistos = new Set<string>();
    for (const a of aplicar) {
      if (vistos.has(a.origenId)) {
        throw new BadRequestException(
          'El mismo anticipo o saldo a favor va una sola vez en la factura.',
        );
      }
      vistos.add(a.origenId);
      const saldo =
        a.tipo === 'ANTICIPO'
          ? disponibles.anticipos.find((x) => x.movimientoId === a.origenId)
              ?.saldo
          : disponibles.saldosAFavor.find((x) => x.facturaId === a.origenId)
              ?.saldo;
      if (saldo === undefined) {
        throw new BadRequestException(
          a.tipo === 'ANTICIPO'
            ? 'Ese anticipo no es de este cliente o ya no tiene saldo.'
            : 'Ese saldo a favor no es de este cliente o ya se usó.',
        );
      }
      if (Math.round(a.valor * 100) > Math.round(saldo * 100)) {
        throw new BadRequestException(
          `${a.tipo === 'ANTICIPO' ? 'Al anticipo' : 'Al saldo a favor'} solo le quedan ${saldo}.`,
        );
      }
    }
  }

  /**
   * Deja registrado lo que se aplicó al emitir la factura. El anticipo ya va
   * en el asiento de la factura (débito 280505), así que el cruce apunta a
   * ese asiento; el saldo a favor no lleva asiento, como siempre.
   */
  async registrarAlFacturar(
    ctx: CtxEmpresa,
    datos: {
      facturaId: string;
      terceroId: string;
      asientoId: string;
      fecha: string;
      aplicar: readonly AplicarAlFacturar[];
    },
    t: Tx,
  ): Promise<void> {
    for (const a of datos.aplicar) {
      if (a.tipo === 'SALDO_A_FAVOR') {
        await this.ventas.ajustarPagadoEnTx(ctx, a.origenId, -a.valor, t);
      }
      await this.ventas.ajustarPagadoEnTx(ctx, datos.facturaId, a.valor, t);
      await t.query(
        `INSERT INTO cruce_cartera
           (empresa_id, tipo, tercero_id, origen_movimiento_id, origen_venta_id,
            destino_venta_id, valor, fecha, asiento_id, creado_por, en_factura)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [
          ctx.empresaId,
          a.tipo,
          datos.terceroId,
          a.tipo === 'ANTICIPO' ? a.origenId : null,
          a.tipo === 'SALDO_A_FAVOR' ? a.origenId : null,
          datos.facturaId,
          a.valor,
          datos.fecha,
          a.tipo === 'ANTICIPO' ? datos.asientoId : null,
          ctx.usuarioId,
        ],
      );
    }
  }

  /**
   * Aplica un anticipo o un saldo a favor a una factura del mismo cliente.
   *
   * Anticipo: el anticipo (280505) pasa a abonar la factura (130505), con
   * asiento. Saldo a favor: lo que le sobra a una factura pasa a otra del
   * mismo cliente; las dos están en 130505 con el mismo tercero, así que no
   * hay asiento: solo cambia `monto_pagado` en las dos.
   */
  async crear(
    ctx: CtxEmpresa,
    datos: {
      tipo: 'ANTICIPO' | 'SALDO_A_FAVOR';
      origenId: string;
      destinoFacturaId: string;
      valor: number;
      fecha: string;
    },
    tx?: Tx,
  ): Promise<CruceCartera> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const destino = fila<{ tercero_id: string; tipo: string }>(
          await t.query(
            'SELECT tercero_id, tipo FROM venta_documento WHERE id = $1',
            [datos.destinoFacturaId],
          ),
        );
        if (destino === undefined || destino.tipo !== 'FACTURA') {
          throw new NotFoundException(
            'La factura a la que se aplica no existe.',
          );
        }
        const disponibles = await this.disponiblesDe(
          ctx,
          destino.tercero_id,
          t,
        );
        const centavos = Math.round(datos.valor * 100);

        let asientoId: string | null = null;
        if (datos.tipo === 'ANTICIPO') {
          const anticipo = disponibles.anticipos.find(
            (a) => a.movimientoId === datos.origenId,
          );
          if (anticipo === undefined) {
            throw new BadRequestException(
              'Ese anticipo no es de este cliente o ya no tiene saldo.',
            );
          }
          if (centavos > Math.round(anticipo.saldo * 100)) {
            throw new BadRequestException(
              `Al anticipo solo le quedan ${anticipo.saldo}.`,
            );
          }
          asientoId = await this.asentarAnticipo(
            ctx,
            destino.tercero_id,
            datos,
            t,
          );
          await this.ventas.ajustarPagadoEnTx(
            ctx,
            datos.destinoFacturaId,
            datos.valor,
            t,
          );
        } else {
          const saldo = disponibles.saldosAFavor.find(
            (s) => s.facturaId === datos.origenId,
          );
          if (saldo === undefined) {
            throw new BadRequestException(
              'Esa factura no es de este cliente o no tiene saldo a favor.',
            );
          }
          if (datos.origenId === datos.destinoFacturaId) {
            throw new BadRequestException(
              'El saldo a favor se aplica a otra factura, no a la misma.',
            );
          }
          if (centavos > Math.round(saldo.saldo * 100)) {
            throw new BadRequestException(
              `A ${saldo.factura} solo le quedan ${saldo.saldo} a favor.`,
            );
          }
          await this.ventas.ajustarPagadoEnTx(
            ctx,
            datos.origenId,
            -datos.valor,
            t,
          );
          await this.ventas.ajustarPagadoEnTx(
            ctx,
            datos.destinoFacturaId,
            datos.valor,
            t,
          );
        }

        const creado = fila<{ id: string }>(
          await t.query(
            `INSERT INTO cruce_cartera
               (empresa_id, tipo, tercero_id, origen_movimiento_id, origen_venta_id,
                destino_venta_id, valor, fecha, asiento_id, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [
              ctx.empresaId,
              datos.tipo,
              destino.tercero_id,
              datos.tipo === 'ANTICIPO' ? datos.origenId : null,
              datos.tipo === 'SALDO_A_FAVOR' ? datos.origenId : null,
              datos.destinoFacturaId,
              datos.valor,
              datos.fecha,
              asientoId,
              ctx.usuarioId,
            ],
          ),
        );
        if (creado === undefined)
          throw new BadRequestException('No se pudo registrar el cruce.');
        return this.obtener(ctx, creado.id, t);
      },
      tx,
    );
  }

  /** Deshace el cruce: el anticipo o el saldo a favor vuelven a donde estaban. */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<CruceCartera> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const cruce = fila<{
          tipo: 'ANTICIPO' | 'SALDO_A_FAVOR';
          estado: string;
          origen_venta_id: string | null;
          destino_venta_id: string;
          valor: string;
          asiento_id: string | null;
          tercero_id: string;
          en_factura: boolean;
        }>(
          await t.query(
            `SELECT tipo, estado, origen_venta_id, destino_venta_id, valor, asiento_id,
                    tercero_id, en_factura
               FROM cruce_cartera WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (cruce === undefined)
          throw new NotFoundException('Ese cruce no existe.');
        if (cruce.estado === 'ANULADO')
          throw new BadRequestException('Este cruce ya está anulado.');
        const valor = Number(cruce.valor);

        await this.ventas.ajustarPagadoEnTx(
          ctx,
          cruce.destino_venta_id,
          -valor,
          t,
        );
        if (cruce.tipo === 'ANTICIPO' && cruce.en_factura) {
          // Aplicado al emitir: su asiento es el de la factura, que sigue
          // vigente. Se asienta solo la inversa del cruce: la factura vuelve
          // a Clientes y el anticipo recupera su saldo.
          await this.asentarAnticipo(
            ctx,
            cruce.tercero_id,
            {
              destinoFacturaId: cruce.destino_venta_id,
              valor,
              fecha: hoyEnColombia(),
            },
            t,
            `Anulación del anticipo aplicado · ${motivo}`,
          );
        } else if (cruce.tipo === 'ANTICIPO' && cruce.asiento_id !== null) {
          await this.recibos.invertirAsiento(
            ctx,
            cruce.asiento_id,
            {
              fecha: hoyEnColombia(),
              glosa: `Anulación del cruce de anticipo · ${motivo}`,
              facturaId: cruce.destino_venta_id,
            },
            t,
          );
        } else if (cruce.origen_venta_id !== null) {
          // La factura de origen recupera el saldo a favor que tenía: puede
          // pasar de lo que se le debe, a propósito.
          await this.ventas.ajustarPagadoEnTx(
            ctx,
            cruce.origen_venta_id,
            valor,
            t,
            {
              restituir: true,
            },
          );
        }

        await t.query(
          `UPDATE cruce_cartera
              SET estado = 'ANULADO', motivo_anulacion = $2, anulado_en = now(), anulado_por = $3
            WHERE id = $1`,
          [id, motivo.trim(), ctx.usuarioId],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  async obtener(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<CruceCartera> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS_CRUCE} FROM cruce_cartera x WHERE x.id = $1`,
            [id],
          ),
        );
        if (f === undefined)
          throw new NotFoundException('Ese cruce no existe.');
        return aCruce(f);
      },
      tx,
    );
  }

  /** El anticipo (280505) abona la factura (130505): débito al anticipo, crédito a Clientes. */
  private async asentarAnticipo(
    ctx: CtxEmpresa,
    terceroId: string,
    datos: { destinoFacturaId: string; valor: number; fecha: string },
    t: Tx,
    /** Con glosa, es la inversa: Clientes al débito, el anticipo al crédito. */
    reversa?: string,
  ): Promise<string> {
    const concepto = await this.nucleo.conceptoPorCodigo(
      ctx,
      'NG-ANTICIPO-CLIENTE',
      t,
    );
    const cartera = await this.nucleo.cuenta(ctx, CODIGO_CARTERA, t);
    if (concepto.cuenta === null || cartera === null) {
      throw new BadRequestException(
        'Falta la cuenta de anticipos de clientes o la de cartera.',
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
        [datos.destinoFacturaId],
      ),
    );
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: datos.fecha,
        glosa:
          reversa === undefined
            ? `Anticipo del cliente aplicado a la factura ${factura?.numero ?? ''}`
            : `${reversa} · factura ${factura?.numero ?? ''}`,
        lineas: [
          {
            cuentaId: concepto.cuenta.id,
            debito: reversa === undefined ? datos.valor : 0,
            credito: reversa === undefined ? 0 : datos.valor,
            terceroId,
            conceptoId: concepto.id,
          },
          {
            cuentaId: cartera.id,
            debito: reversa === undefined ? 0 : datos.valor,
            credito: reversa === undefined ? datos.valor : 0,
            terceroId,
          },
        ],
      },
      { origenTipo: 'VENTA', origenId: datos.destinoFacturaId },
      t,
    );
    return asiento.id;
  }
}

function aCruce(f: Record<string, unknown>): CruceCartera {
  return {
    id: f.id as string,
    tipo: f.tipo as 'ANTICIPO' | 'SALDO_A_FAVOR',
    terceroId: f.tercero_id as string,
    terceroNombre: f.tercero_nombre as string,
    origen: (f.origen as string | null) ?? '',
    destinoFacturaId: f.destino_venta_id as string,
    destino: (f.destino as string | null) ?? '',
    valor: Number(f.valor),
    fecha: f.fecha as string,
    estado: f.estado as 'VIGENTE' | 'ANULADO',
    motivoAnulacion: f.motivo_anulacion as string | null,
  };
}
