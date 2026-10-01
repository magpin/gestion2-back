import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import type { CrearNotaCreditoDto } from '../dto/nota-credito.dto';
import { calcularDevolucionPorLinea, calcularLinea } from './venta.reglas';
import {
  CAMPOS_DOCUMENTO,
  VentaDocumentoService,
  type VentaDocumentoDetalle,
  type VentaDocumentoLineaResumen,
  type VentaDocumentoResumen,
} from './venta-documento.service';
import { esDeHoy, hoyEnColombia } from '../../../common/fecha';
import { cuentaInactiva } from '../../../common/contabilidad/cuenta-inactiva';

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, concepto_id, cuenta_id, detalle, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario`;

const CODIGO_CUENTA_CARTERA = '130505';
const CODIGO_CUENTA_IVA_GENERADO = '240805';
/** [BASE]: devoluciones que rebajan el ingreso — no la cuenta de ingreso original. */
const CODIGO_CUENTA_DEVOLUCIONES = '417505';
const CODIGO_COMPROBANTE_VENTA = 'CI';

/**
 * Nota crédito: reversa una factura EMITIDA, completa o por partes.
 *
 * Sin `lineas` en el DTO devuelve la factura entera —el caso más común, y el
 * único que existía hasta el paso 8 del plan de ajustes—. Con `lineas`
 * devuelve solo esas cantidades, y una misma factura puede recibir varias
 * notas: entre todas no pueden devolver más de lo que se vendió, y de eso se
 * encarga `calcularDevolucionPorLinea` contra lo que las notas anteriores no
 * anuladas ya sacaron.
 *
 * Corrige el libro; el inventario NO se toca acá — ver decisión 3 de
 * `docs/planes/ventas-backend.md`. Si la mercancía vuelve físicamente a
 * bodega, quien la recibe registra una entrada de ajuste desde
 * `inventario`, un acto aparte y deliberado.
 *
 * El asiento espejo es más simple que el de la factura: sin las líneas de
 * costo/inventario (no se tocan), y el ingreso va contra `417505`
 * devoluciones en ventas —no contra la cuenta de ingreso original—, así el
 * ingreso bruto del período no se pierde en el libro.
 */
@Injectable()
export class NotaCreditoService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly ventas: VentaDocumentoService,
    private readonly retenciones: RetencionesApi,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearNotaCreditoDto,
    tx?: Tx,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        if (!esDeHoy(dto.fecha)) {
          throw new BadRequestException(
            `La nota crédito se emite con la fecha de hoy (${hoyEnColombia()}), no antes ni después.`,
          );
        }
        const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
          ctx,
          new Date(dto.fecha),
          t,
        );
        if (!periodoAbierto) {
          throw new BadRequestException(
            'El período de esta fecha está cerrado. No se puede emitir la nota crédito.',
          );
        }

        // El candado contra una anulación simultánea: `VentaDocumentoService.
        // anular` toma la factura `FOR UPDATE` y rechaza si tiene notas vivas.
        // Sin esto, la factura podía anularse mientras esta nota se emitía y la
        // nota quedaba corrigiendo una factura anulada. Se toma antes de leerla,
        // para leerla ya con la anulación confirmada si la hubo.
        await t.query(`SELECT 1 FROM venta_documento WHERE id = $1 FOR SHARE`, [
          dto.documentoOrigenId,
        ]);
        const factura = await this.ventas.porId(
          ctx,
          'FACTURA',
          dto.documentoOrigenId,
          t,
        );
        if (factura.estado !== 'EMITIDA') {
          throw new BadRequestException(
            'Solo se puede emitir una nota crédito sobre una factura vigente (no anulada).',
          );
        }
        // Lo que vendió está en los saldos iniciales, no en un asiento: una nota
        // reversaría un ingreso que el sistema nunca registró.
        if (factura.historica) {
          throw new BadRequestException(
            'Esa factura es histórica: se emitió antes de usar el sistema y no tiene asiento que corregir. La nota va en el sistema donde se emitió.',
          );
        }

        const cuentaDevoluciones = await this.nucleo.cuenta(
          ctx,
          CODIGO_CUENTA_DEVOLUCIONES,
          t,
        );
        if (cuentaDevoluciones === null) {
          throw cuentaInactiva(
            'devoluciones en ventas',
            CODIGO_CUENTA_DEVOLUCIONES,
          );
        }

        const cuentaCartera = await this.nucleo.cuenta(
          ctx,
          CODIGO_CUENTA_CARTERA,
          t,
        );
        if (cuentaCartera === null) {
          throw cuentaInactiva('cartera', CODIGO_CUENTA_CARTERA);
        }

        const totalIva = Number(factura.total_iva);
        let cuentaIvaId: string | null = null;
        if (totalIva > 0) {
          const cuentaIva = await this.nucleo.cuenta(
            ctx,
            CODIGO_CUENTA_IVA_GENERADO,
            t,
          );
          if (cuentaIva === null) {
            throw cuentaInactiva('IVA generado', CODIGO_CUENTA_IVA_GENERADO);
          }
          cuentaIvaId = cuentaIva.id;
        }

        const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
          ctx,
          CODIGO_COMPROBANTE_VENTA,
          t,
        );
        if (comprobante === null) {
          throw new BadRequestException(
            'La empresa no tiene el comprobante de ingreso sembrado.',
          );
        }

        const numero = await this.nucleo.tomarConsecutivo(
          ctx,
          'NOTA_CREDITO',
          t,
          dto.fecha,
        );

        // Qué se devuelve: todas las líneas, o las que pide el DTO.
        const aDevolver = await this.armarLineasADevolver(factura, dto, t);
        const subtotal = aDevolver.reduce((s, l) => s + l.subtotal, 0);
        const totalIvaDevuelto = aDevolver.reduce((s, l) => s + l.ivaValor, 0);
        const total = aDevolver.reduce((s, l) => s + l.total, 0);

        // Débito devoluciones + débito IVA, crédito cartera: exactamente lo
        // contrario de cómo entró la factura, sin las líneas de costo/inventario.
        // La línea de servicio u otro ingreso no es una devolución de mercancía:
        // reversa la cuenta del concepto a la que entró (Fase 8).
        const porCuenta = new Map<string, number>();
        for (const l of aDevolver) {
          const cuenta = l.cuentaId ?? cuentaDevoluciones.id;
          porCuenta.set(cuenta, (porCuenta.get(cuenta) ?? 0) + l.subtotal);
        }
        const lineasAsiento: LineaAsientoDto[] = [...porCuenta].map(
          ([cuentaId, valor]) => ({ cuentaId, debito: valor, credito: 0 }),
        );
        if (cuentaIvaId !== null) {
          lineasAsiento.push({
            cuentaId: cuentaIvaId,
            // Misma exigencia que en `FacturaService`: la cuenta de IVA
            // generado exige base gravable (`fn_exigencias_cuenta`). Acá la
            // base es el subtotal de la factura que se está reversando.
            baseGravable: subtotal,
            debito: totalIvaDevuelto,
            credito: 0,
          });
        }
        lineasAsiento.push({
          cuentaId: cuentaCartera.id,
          terceroId: factura.tercero_id,
          debito: 0,
          credito: total,
        });

        // Lo que la nota devuelve de la venta baja también su autorretención,
        // en la misma proporción: si no, la 236575 y el 350 seguían con ella.
        const documentoId = randomUUID();
        const subtotalFactura = Number(factura.subtotal);
        if (subtotalFactura > 0) {
          lineasAsiento.push(
            ...(await this.retenciones.reversarAutorretencionPorNota(
              ctx,
              {
                ventaId: factura.id,
                notaId: documentoId,
                proporcion: Math.min(subtotal / subtotalFactura, 1),
                fecha: dto.fecha,
              },
              t,
            )),
          );
        }
        const numeroFactura = `${factura.prefijo ?? ''}${factura.consecutivo}`;
        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante.id,
            fecha: dto.fecha,
            glosa: `Nota crédito ${numero.numero} — factura ${numeroFactura}: ${dto.motivo}`,
            lineas: lineasAsiento,
          },
          { origenTipo: 'VENTA', origenId: documentoId },
          t,
        );

        const documento = fila<VentaDocumentoResumen>(
          await t.query(
            `INSERT INTO venta_documento
             (id, empresa_id, tipo, tercero_id, fecha, prefijo, consecutivo,
              resolucion_id, documento_origen_id, subtotal, total_iva, total,
              asiento_id, creado_por)
           VALUES ($1, $2, 'NOTA_CREDITO', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${CAMPOS_DOCUMENTO}`,
            [
              documentoId,
              ctx.empresaId,
              factura.tercero_id,
              dto.fecha,
              numero.prefijo,
              numero.consecutivo,
              numero.resolucionId,
              dto.documentoOrigenId,
              subtotal,
              totalIvaDevuelto,
              total,
              asiento.id,
              ctx.usuarioId,
            ],
          ),
        );
        if (documento === undefined) {
          throw new BadRequestException('No se pudo crear la nota crédito.');
        }

        // El precio y la tarifa son los de la factura: corregir no renegocia.
        // `costo_unitario` se omite: no toca el kardex. `linea_origen_id` es lo
        // que permite que una nota siguiente sepa cuánto queda por devolver
        // —también en la devolución completa, que es una nota más—.
        const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
        for (let i = 0; i < aDevolver.length; i++) {
          const l = aDevolver[i];
          const insertada = fila<VentaDocumentoLineaResumen>(
            await t.query(
              `INSERT INTO venta_documento_linea
               (empresa_id, venta_documento_id, orden, producto_id, cantidad,
                precio_unitario, iva_tarifa, subtotal, iva_valor, total,
                linea_origen_id, concepto_id, cuenta_id, detalle)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING ${CAMPOS_LINEA}`,
              [
                ctx.empresaId,
                documento.id,
                i + 1,
                l.productoId,
                l.cantidad,
                l.precioUnitario,
                l.ivaTarifa,
                l.subtotal,
                l.ivaValor,
                l.total,
                l.lineaOrigenId,
                l.conceptoId,
                l.cuentaId,
                l.detalle,
              ],
            ),
          );
          if (insertada === undefined) {
            throw new BadRequestException(
              'No se pudo registrar una línea de la nota crédito.',
            );
          }
          lineasInsertadas.push(insertada);
        }

        return { ...documento, lineas: lineasInsertadas };
      },
      tx,
    );
  }

  /**
   * Qué líneas devuelve esta nota, y por cuánto.
   *
   * Sin `dto.lineas`, todas las de la factura por su cantidad completa —menos
   * lo que notas anteriores ya devolvieron, porque una segunda nota "completa"
   * sobre la misma factura no puede duplicar la devolución—. Con `dto.lineas`,
   * solo esas, validando cada una contra lo que queda pendiente.
   */
  private async armarLineasADevolver(
    factura: VentaDocumentoDetalle,
    dto: CrearNotaCreditoDto,
    t: Tx,
  ): Promise<
    Array<{
      lineaOrigenId: string;
      productoId: string | null;
      /** La línea de concepto hereda el concepto, la cuenta y el detalle. */
      conceptoId: string | null;
      cuentaId: string | null;
      detalle: string | null;
      cantidad: number;
      precioUnitario: number;
      ivaTarifa: number;
      subtotal: number;
      ivaValor: number;
      total: number;
    }>
  > {
    const yaDevuelto = await this.devueltoPorLinea(
      factura.lineas.map((l) => l.id),
      t,
    );

    // Sin `lineas`: todo lo que quede por devolver. Las líneas ya devueltas
    // del todo se saltan —una segunda nota "completa" acredita el resto, no
    // el total otra vez—, y si no queda ninguna, el error de abajo lo dice.
    const pedido =
      dto.lineas ??
      factura.lineas
        .map((l) => ({
          lineaOrigenId: l.id,
          cantidad: Number(l.cantidad) - (yaDevuelto.get(l.id) ?? 0),
        }))
        .filter((l) => l.cantidad > 0);

    const porId = new Map(factura.lineas.map((l) => [l.id, l]));
    const resultado = [];
    for (const p of pedido) {
      const original = porId.get(p.lineaOrigenId);
      if (original === undefined) {
        throw new BadRequestException(
          'Una de las líneas que quiere devolver no es de esta factura.',
        );
      }
      const devolucion = calcularDevolucionPorLinea(
        Number(original.cantidad),
        yaDevuelto.get(p.lineaOrigenId) ?? 0,
        p.cantidad,
      );
      if (!devolucion.ok) {
        throw new BadRequestException(devolucion.motivo);
      }

      // El cálculo es el mismo de una línea de venta: así el IVA de la nota
      // se redondea igual que el de la factura y los dos asientos cuadran.
      const calculada = calcularLinea({
        cantidad: p.cantidad,
        precioUnitario: Number(original.precio_unitario),
        ivaTarifa: Number(original.iva_tarifa),
      });
      resultado.push({
        lineaOrigenId: p.lineaOrigenId,
        productoId: original.producto_id,
        conceptoId: original.concepto_id ?? null,
        cuentaId: original.concepto_id ? (original.cuenta_id ?? null) : null,
        detalle: original.detalle ?? null,
        ...calculada,
      });
    }

    if (resultado.length === 0) {
      throw new BadRequestException(
        'Esta factura ya se devolvió completa: no queda nada por acreditar.',
      );
    }
    return resultado;
  }

  /**
   * Cuánto se devolvió ya de cada línea, sumando las notas crédito que la
   * apuntan y no están anuladas. Una nota anulada no devolvió nada: su
   * asiento se reversó.
   */
  private async devueltoPorLinea(
    lineaIds: string[],
    t: Tx,
  ): Promise<Map<string, number>> {
    if (lineaIds.length === 0) return new Map();
    const devueltas = filas<{ linea_origen_id: string; cantidad: string }>(
      await t.query(
        `SELECT l.linea_origen_id, sum(l.cantidad)::text AS cantidad
           FROM venta_documento_linea l
           JOIN venta_documento d ON d.id = l.venta_documento_id
          WHERE l.linea_origen_id = ANY($1)
            AND d.tipo = 'NOTA_CREDITO'
            AND d.estado <> 'ANULADA'
          GROUP BY l.linea_origen_id`,
        [lineaIds],
      ),
    );
    return new Map(
      devueltas.map((d) => [d.linea_origen_id, Number(d.cantidad)]),
    );
  }
}
