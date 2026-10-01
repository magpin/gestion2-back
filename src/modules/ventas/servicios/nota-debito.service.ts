import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { esDeHoy, hoyEnColombia } from '../../../common/fecha';
import { cuentaDeIngreso } from './concepto-ingreso';
import { TxService } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { CrearNotaDebitoDto } from '../dto/nota-debito.dto';
import { calcularLineas } from './venta.reglas';
import {
  CAMPOS_DOCUMENTO,
  VentaDocumentoService,
  type VentaDocumentoDetalle,
  type VentaDocumentoLineaResumen,
  type VentaDocumentoResumen,
} from './venta-documento.service';
import { cuentaInactiva } from '../../../common/contabilidad/cuenta-inactiva';

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, concepto_id, cuenta_id, detalle, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario`;

const CODIGO_CUENTA_CARTERA = '130505';
const CODIGO_CUENTA_IVA_GENERADO = '240805';
const CODIGO_COMPROBANTE_VENTA = 'CI';

/**
 * Nota débito de venta: le cobra MÁS al cliente sobre una factura que ya
 * existe — un interés de mora, un flete que no se cobró, un mayor valor que
 * se facturó de menos.
 *
 * Es el espejo exacto de la nota crédito en el libro: débito a cartera y
 * crédito al ingreso, que es justo al revés de la nota crédito. Y como la
 * nota crédito, **no toca el kardex**: no sale ni entra mercancía, se cobra
 * plata. Si además hay que entregar más producto, eso es otra factura.
 *
 * Lo que sí es distinto: sus líneas no copian a la factura. Una nota débito
 * rara vez es "más de lo mismo" —de hecho, si lo fuera, lo natural sería
 * facturar otra vez—, así que cada línea trae su producto, su cantidad y su
 * precio, y el ingreso va contra la cuenta de ingreso de ese producto. Para
 * cobrar un flete o un interés, la empresa necesita tenerlo como producto en
 * su catálogo; es la misma condición que ya tiene cualquier venta.
 *
 * Numera contra la resolución DIAN de tipo `NOTA_DEBITO`, que es propia: si la
 * empresa no la registró, esto falla con el mensaje de `tomarConsecutivo` y el
 * frontend ofrece ir a registrarla.
 */
@Injectable()
export class NotaDebitoService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly ventas: VentaDocumentoService,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearNotaDebitoDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      if (!esDeHoy(dto.fecha)) {
        throw new BadRequestException(
          `La nota débito se emite con la fecha de hoy (${hoyEnColombia()}), no antes ni después.`,
        );
      }

      for (const l of dto.lineas) {
        if ((l.productoId === undefined) === (l.conceptoId === undefined)) {
          throw new BadRequestException(
            'Cada línea es un producto o un servicio: elija uno de los dos.',
          );
        }
      }
      const productoIds = dto.lineas
        .map((l) => l.productoId)
        .filter((id): id is string => id !== undefined);
      if (new Set(productoIds).size !== productoIds.length) {
        throw new BadRequestException(
          'No repita el mismo producto en dos líneas — sume la cantidad en una sola.',
        );
      }

      const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
        ctx,
        new Date(dto.fecha),
        t,
      );
      if (!periodoAbierto) {
        throw new BadRequestException(
          'El período de esta fecha está cerrado. No se puede emitir la nota débito.',
        );
      }

      // El candado contra una anulación simultánea de la factura: ver
      // `NotaCreditoService.crear`.
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
          'Solo se puede emitir una nota débito sobre una factura vigente (no anulada).',
        );
      }
      if (factura.historica) {
        throw new BadRequestException(
          'Esa factura es histórica: se emitió antes de usar el sistema y no tiene asiento que corregir. La nota va en el sistema donde se emitió.',
        );
      }

      // Una sola vez para todas las líneas, igual que en la factura.
      const responsableIva = await this.nucleo.esResponsableDeIva(
        ctx,
        dto.fecha,
        t,
      );

      const cuentaIngresoDe: Array<string | null> = [];
      /** Por línea: el concepto de ingreso, o `null` si es producto. */
      const conceptoDe: Array<{ conceptoId: string; cuentaId: string } | null> =
        [];
      const entradas = [];
      for (const l of dto.lineas) {
        if (l.conceptoId !== undefined) {
          const ingreso = await cuentaDeIngreso(
            this.nucleo,
            ctx,
            l.conceptoId,
            t,
          );
          cuentaIngresoDe.push(ingreso.cuentaId);
          conceptoDe.push(ingreso);
          entradas.push({
            cantidad: l.cantidad,
            precioUnitario: l.precioUnitario,
            ivaTarifa: responsableIva ? (l.ivaTarifa ?? 0) : 0,
          });
          continue;
        }
        const producto = await this.inventario.producto(ctx, l.productoId!, t);
        if (producto === null || !producto.activo) {
          throw new BadRequestException(
            `El producto ${l.productoId} no existe o está inactivo.`,
          );
        }
        if (producto.cuenta_ingreso_id === null) {
          throw new BadRequestException(
            `El producto ${producto.codigo} no tiene cuenta de ingreso configurada; sin ella el cobro no sabe contra qué acreditarse.`,
          );
        }
        cuentaIngresoDe.push(producto.cuenta_ingreso_id);
        conceptoDe.push(null);
        entradas.push({
          cantidad: l.cantidad,
          precioUnitario: l.precioUnitario,
          ivaTarifa: responsableIva ? Number(producto.iva_tarifa) : 0,
        });
      }

      const { lineas, totales } = calcularLineas(entradas);

      const cuentaCartera = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_CARTERA,
        t,
      );
      if (cuentaCartera === null) {
        throw cuentaInactiva('cartera', CODIGO_CUENTA_CARTERA);
      }

      let cuentaIvaId: string | null = null;
      if (totales.totalIva > 0) {
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
        'NOTA_DEBITO',
        t,
        dto.fecha,
      );

      // Débito cartera, crédito ingreso (+ IVA si liquida): el mismo asiento
      // de una factura, sin las líneas de costo/inventario porque no sale
      // mercancía.
      const lineasAsiento: LineaAsientoDto[] = [
        {
          cuentaId: cuentaCartera.id,
          terceroId: factura.tercero_id,
          debito: totales.total,
          credito: 0,
        },
      ];
      for (let i = 0; i < lineas.length; i++) {
        lineasAsiento.push({
          cuentaId: cuentaIngresoDe[i]!,
          debito: 0,
          credito: lineas[i].subtotal,
        });
      }
      if (cuentaIvaId !== null) {
        lineasAsiento.push({
          cuentaId: cuentaIvaId,
          // La cuenta de IVA generado exige base gravable, igual que en la
          // factura: acá la base es el subtotal que se está cobrando.
          baseGravable: totales.subtotal,
          debito: 0,
          credito: totales.totalIva,
        });
      }

      const documentoId = randomUUID();
      const numeroFactura = `${factura.prefijo ?? ''}${factura.consecutivo}`;
      const asiento = await this.contabilidad.asentar(
        ctx,
        {
          comprobanteTipoId: comprobante.id,
          fecha: dto.fecha,
          glosa: `Nota débito ${numero.numero} — factura ${numeroFactura}: ${dto.motivo}`,
          lineas: lineasAsiento,
          centroCostoId: factura.centro_costo_id ?? undefined,
        },
        { origenTipo: 'VENTA', origenId: documentoId },
        t,
      );

      const documento = fila<VentaDocumentoResumen>(
        await t.query(
          `INSERT INTO venta_documento
             (id, empresa_id, tipo, tercero_id, fecha, prefijo, consecutivo,
              resolucion_id, documento_origen_id, subtotal, total_iva, total,
              asiento_id, creado_por, centro_costo_id)
           VALUES ($1, $2, 'NOTA_DEBITO', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
            totales.subtotal,
            totales.totalIva,
            totales.total,
            asiento.id,
            ctx.usuarioId,
            factura.centro_costo_id,
          ],
        ),
      );
      if (documento === undefined) {
        throw new BadRequestException('No se pudo crear la nota débito.');
      }

      // Sin `linea_origen_id`: estas líneas no corrigen a ninguna de la
      // factura, cobran algo nuevo. Sin `costo_unitario`: no toca el kardex.
      const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        const insertada = fila<VentaDocumentoLineaResumen>(
          await t.query(
            `INSERT INTO venta_documento_linea
               (empresa_id, venta_documento_id, orden, producto_id, cantidad,
                precio_unitario, iva_tarifa, subtotal, iva_valor, total,
                concepto_id, cuenta_id, detalle)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING ${CAMPOS_LINEA}`,
            [
              ctx.empresaId,
              documento.id,
              i + 1,
              dto.lineas[i].productoId ?? null,
              l.cantidad,
              l.precioUnitario,
              l.ivaTarifa,
              l.subtotal,
              l.ivaValor,
              l.total,
              conceptoDe[i]?.conceptoId ?? null,
              conceptoDe[i]?.cuentaId ?? null,
              conceptoDe[i] === null ? null : dto.lineas[i].detalle!.trim(),
            ],
          ),
        );
        if (insertada === undefined) {
          throw new BadRequestException(
            'No se pudo registrar una línea de la nota débito.',
          );
        }
        lineasInsertadas.push(insertada);
      }

      return { ...documento, lineas: lineasInsertadas };
    });
  }
}
