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
import { CompraService } from './compra.service';
import { ComprobanteEgresoService } from './comprobante-egreso.service';

const CODIGO_PROVEEDORES = '220505';

/** Un anticipo entregado a un proveedor, con lo que le queda por cruzar. */
export interface AnticipoProveedor {
  movimientoId: string;
  fecha: string;
  detalle: string;
  /** El bruto: lo que bajó al anticipo (133005). */
  valor: number;
  /** Lo que se le retuvo al entregarlo. */
  retenido: number;
  cruzado: number;
  saldo: number;
}

export interface CrucePago {
  id: string;
  terceroId: string;
  terceroNombre: string;
  origen: string;
  destinoCompraId: string;
  destino: string;
  valor: number;
  retencionReversada: number;
  fecha: string;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
}

const CAMPOS = `
  x.id, x.tercero_id, x.destino_compra_id, x.valor, x.retencion_reversada, x.fecha, x.estado,
  x.motivo_anulacion,
  (SELECT COALESCE(t.razon_social, concat_ws(' ', t.primer_nombre, t.primer_apellido))
     FROM tercero t WHERE t.id = x.tercero_id) AS tercero_nombre,
  (SELECT m.detalle FROM movimiento_concepto m WHERE m.id = x.origen_movimiento_id) AS origen,
  (SELECT d.numero_factura_proveedor FROM compra_documento d
    WHERE d.id = x.destino_compra_id) AS destino`;

/**
 * Cruzar un anticipo entregado a un proveedor con la compra que llegó
 * después (D11b).
 *
 * La compra ya retuvo lo correcto, con su concepto y sobre su base. Lo que el
 * anticipo retuvo por la parte que se cruza sobra: se reversa en proporción
 * —en el motor (para la 350) y en el asiento—, y el proveedor recibe esa
 * diferencia como menor abono. El asiento del cruce:
 *
 *   Débito  Proveedores (220505)        lo cruzado menos la retención reversada
 *   Débito  Retención (2365xx)          la retención reversada
 *   Crédito Anticipo (133005)           lo cruzado
 */
@Injectable()
export class CrucePagoService {
  constructor(
    private readonly tx: TxService,
    private readonly compras: CompraService,
    private readonly comprobantes: ComprobanteEgresoService,
    private readonly nucleo: NucleoApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly retenciones: RetencionesApi,
  ) {}

  /** Los anticipos de un proveedor que todavía tienen algo por cruzar. */
  async anticiposDe(
    ctx: CtxEmpresa,
    terceroId: string,
    tx?: Tx,
  ): Promise<AnticipoProveedor[]> {
    return this.tx.enContexto(
      ctx,
      async (t) =>
        filas<{
          id: string;
          fecha: string;
          detalle: string;
          valor: string;
          movido: string;
          cruzado: string;
        }>(
          await t.query(
            `SELECT m.id, m.fecha, m.detalle, m.valor_concepto AS valor, m.valor_movido AS movido,
                    coalesce((SELECT sum(x.valor) FROM cruce_pago x
                               WHERE x.origen_movimiento_id = m.id AND x.estado = 'VIGENTE'), 0)
                    -- Lo devuelto también baja el anticipo (PC19).
                    + coalesce((SELECT sum(d.valor_concepto) FROM movimiento_concepto d
                                 WHERE d.devuelve_a = m.id AND d.estado = 'VIGENTE'), 0)
                      AS cruzado
               FROM movimiento_concepto m
               JOIN concepto_movimiento c ON c.id = m.concepto_id
              WHERE c.codigo = 'NG-ANTICIPO-PROVEEDOR' AND m.tercero_id = $1
                AND m.estado = 'VIGENTE' AND m.direccion = 'SALIDA'
              ORDER BY m.fecha`,
            [terceroId],
          ),
        )
          .map((a) => ({
            movimientoId: a.id,
            fecha: a.fecha,
            detalle: a.detalle,
            valor: Number(a.valor),
            retenido:
              Math.round((Number(a.valor) - Number(a.movido)) * 100) / 100,
            cruzado: Number(a.cruzado),
            saldo:
              Math.round((Number(a.valor) - Number(a.cruzado)) * 100) / 100,
          }))
          .filter((a) => a.saldo > 0),
      tx,
    );
  }

  async listar(ctx: CtxEmpresa, terceroId?: string): Promise<CrucePago[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT ${CAMPOS} FROM cruce_pago x
            ${terceroId === undefined ? '' : 'WHERE x.tercero_id = $1'}
            ORDER BY x.fecha DESC, x.creado_en DESC LIMIT 200`,
          terceroId === undefined ? [] : [terceroId],
        ),
      ).map(aCruce),
    );
  }

  async crear(
    ctx: CtxEmpresa,
    datos: {
      origenId: string;
      destinoCompraId: string;
      valor: number;
      fecha: string;
    },
    tx?: Tx,
  ): Promise<CrucePago> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anticipo = fila<{
          tercero_id: string;
          origen_id: string;
          valor_concepto: string;
          estado: string;
        }>(
          await t.query(
            `SELECT tercero_id, origen_id, valor_concepto, estado FROM movimiento_concepto
              WHERE id = $1 FOR UPDATE`,
            [datos.origenId],
          ),
        );
        if (anticipo === undefined || anticipo.estado !== 'VIGENTE') {
          throw new NotFoundException('Ese anticipo no existe o está anulado.');
        }
        const compra = fila<{ tercero_id: string; tipo: string }>(
          await t.query(
            'SELECT tercero_id, tipo FROM compra_documento WHERE id = $1',
            [datos.destinoCompraId],
          ),
        );
        if (compra === undefined || compra.tipo !== 'FACTURA') {
          throw new NotFoundException('La compra no existe.');
        }
        if (compra.tercero_id !== anticipo.tercero_id) {
          throw new BadRequestException(
            'El anticipo y la compra tienen que ser del mismo proveedor.',
          );
        }
        const disponible = (
          await this.anticiposDe(ctx, anticipo.tercero_id, t)
        ).find((a) => a.movimientoId === datos.origenId);
        if (
          disponible === undefined ||
          Math.round(datos.valor * 100) > Math.round(disponible.saldo * 100)
        ) {
          throw new BadRequestException(
            `Al anticipo solo le quedan ${disponible?.saldo ?? 0} por cruzar.`,
          );
        }

        const id = randomUUID();
        // La retención del anticipo, en la proporción cruzada, se reversa.
        const reversada = await this.retenciones.reversarAnticipo(
          ctx,
          {
            anticipoId: anticipo.origen_id,
            proporcion: datos.valor / Number(anticipo.valor_concepto),
            fecha: datos.fecha,
            texto:
              'Cruce del anticipo con la compra: la compra retiene sobre su propia base y concepto (D11b).',
            cruceId: id,
          },
          t,
        );
        const retencionReversada = reversada.reduce((s, r) => s + r.valor, 0);
        const abono =
          Math.round((datos.valor - retencionReversada) * 100) / 100;

        const asientoId = await this.asentar(
          ctx,
          {
            terceroId: anticipo.tercero_id,
            compraId: datos.destinoCompraId,
            fecha: datos.fecha,
            valor: datos.valor,
            abono,
            reversada,
          },
          t,
        );
        await this.compras.ajustarPagadoEnTx(
          ctx,
          datos.destinoCompraId,
          abono,
          t,
        );

        await t.query(
          `INSERT INTO cruce_pago
             (id, empresa_id, tercero_id, origen_movimiento_id, destino_compra_id, valor,
              retencion_reversada, fecha, asiento_id, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            ctx.empresaId,
            anticipo.tercero_id,
            datos.origenId,
            datos.destinoCompraId,
            datos.valor,
            retencionReversada,
            datos.fecha,
            asientoId,
            ctx.usuarioId,
          ],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  /** Deshace el cruce: el anticipo vuelve a tener saldo y su retención vuelve a estar viva. */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<CrucePago> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const cruce = fila<{
          estado: string;
          destino_compra_id: string;
          valor: string;
          retencion_reversada: string;
          asiento_id: string | null;
        }>(
          await t.query(
            `SELECT estado, destino_compra_id, valor, retencion_reversada, asiento_id
               FROM cruce_pago WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (cruce === undefined)
          throw new NotFoundException('Ese cruce no existe.');
        if (cruce.estado === 'ANULADO')
          throw new BadRequestException('Este cruce ya está anulado.');
        const fecha = hoyEnColombia();
        const abono = Number(cruce.valor) - Number(cruce.retencion_reversada);

        await this.compras.ajustarPagadoEnTx(
          ctx,
          cruce.destino_compra_id,
          -abono,
          t,
        );
        await this.retenciones.restablecerAnticipo(
          ctx,
          { cruceId: id, fecha, texto: `Anulación del cruce · ${motivo}` },
          t,
        );
        if (cruce.asiento_id !== null) {
          await this.comprobantes.invertirAsiento(
            ctx,
            cruce.asiento_id,
            {
              fecha,
              glosa: `Anulación del cruce de anticipo · ${motivo}`,
              compraId: cruce.destino_compra_id,
            },
            t,
          );
        }
        await t.query(
          `UPDATE cruce_pago
              SET estado = 'ANULADO', motivo_anulacion = $2, anulado_en = now(), anulado_por = $3
            WHERE id = $1`,
          [id, motivo.trim(), ctx.usuarioId],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  async obtener(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<CrucePago> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(`SELECT ${CAMPOS} FROM cruce_pago x WHERE x.id = $1`, [
            id,
          ]),
        );
        if (f === undefined)
          throw new NotFoundException('Ese cruce no existe.');
        return aCruce(f);
      },
      tx,
    );
  }

  private async asentar(
    ctx: CtxEmpresa,
    datos: {
      terceroId: string;
      compraId: string;
      fecha: string;
      valor: number;
      abono: number;
      reversada: Array<{ cuentaId: string; base: number; valor: number }>;
    },
    t: Tx,
  ): Promise<string> {
    const concepto = await this.nucleo.conceptoPorCodigo(
      ctx,
      'NG-ANTICIPO-PROVEEDOR',
      t,
    );
    const proveedores = await this.nucleo.cuenta(ctx, CODIGO_PROVEEDORES, t);
    if (concepto.cuenta === null || proveedores === null) {
      throw new BadRequestException(
        'Falta la cuenta de anticipos a proveedores o la de proveedores.',
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
        glosa: `Anticipo al proveedor aplicado a la compra ${compra?.numero ?? ''}`,
        lineas: [
          {
            cuentaId: proveedores.id,
            debito: datos.abono,
            credito: 0,
            terceroId: datos.terceroId,
          },
          ...datos.reversada.map((r) => ({
            cuentaId: r.cuentaId,
            debito: r.valor,
            credito: 0,
            terceroId: datos.terceroId,
            baseGravable: r.base,
            detalle: 'Retención del anticipo que ya practicó la compra',
          })),
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
}

function aCruce(f: Record<string, unknown>): CrucePago {
  return {
    id: f.id as string,
    terceroId: f.tercero_id as string,
    terceroNombre: f.tercero_nombre as string,
    origen: (f.origen as string | null) ?? '',
    destinoCompraId: f.destino_compra_id as string,
    destino: (f.destino as string | null) ?? '',
    valor: Number(f.valor),
    retencionReversada: Number(f.retencion_reversada),
    fecha: f.fecha as string,
    estado: f.estado as 'VIGENTE' | 'ANULADO',
    motivoAnulacion: f.motivo_anulacion as string | null,
  };
}
