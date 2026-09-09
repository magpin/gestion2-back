import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { CrearNotaCreditoDto } from '../dto/nota-credito.dto';
import {
  VentaDocumentoService,
  type VentaDocumentoDetalle,
  type VentaDocumentoLineaResumen,
  type VentaDocumentoResumen,
} from './venta-documento.service';

const CAMPOS_DOCUMENTO = `id, tipo, tercero_id, fecha, estado, prefijo, consecutivo,
                           resolucion_id, documento_origen_id, subtotal, total_iva, total, asiento_id`;

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario`;

const CODIGO_CUENTA_CARTERA = '130505';
const CODIGO_CUENTA_IVA_GENERADO = '240805';
/** [BASE]: devoluciones que rebajan el ingreso — no la cuenta de ingreso original. */
const CODIGO_CUENTA_DEVOLUCIONES = '417505';
const CODIGO_COMPROBANTE_VENTA = 'CI';

/**
 * Nota crédito: reversa una factura EMITIDA, completa — este corte no
 * admite notas parciales (menos cantidad, o solo algunas líneas). Corrige
 * el libro; el inventario NO se toca acá — ver decisión 3 de
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
  ) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearNotaCreditoDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
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

      const cuentaDevoluciones = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_DEVOLUCIONES,
        t,
      );
      if (cuentaDevoluciones === null) {
        throw new BadRequestException(
          `No existe o está inactiva la cuenta de devoluciones en ventas (${CODIGO_CUENTA_DEVOLUCIONES}). Actívala en el plan de cuentas.`,
        );
      }

      const cuentaCartera = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_CARTERA,
        t,
      );
      if (cuentaCartera === null) {
        throw new BadRequestException(
          `No existe o está inactiva la cuenta de cartera (${CODIGO_CUENTA_CARTERA}). Actívala en el plan de cuentas.`,
        );
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
          throw new BadRequestException(
            `No existe o está inactiva la cuenta de IVA generado (${CODIGO_CUENTA_IVA_GENERADO}). Actívala en el plan de cuentas.`,
          );
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

      const subtotal = Number(factura.subtotal);
      const total = Number(factura.total);

      // Débito devoluciones + débito IVA, crédito cartera: exactamente lo
      // contrario de cómo entró la factura, sin las líneas de costo/inventario.
      const lineasAsiento: LineaAsientoDto[] = [
        { cuentaId: cuentaDevoluciones.id, debito: subtotal, credito: 0 },
      ];
      if (cuentaIvaId !== null) {
        lineasAsiento.push({
          cuentaId: cuentaIvaId,
          // Misma exigencia que en `FacturaService`: la cuenta de IVA
          // generado exige base gravable (`fn_exigencias_cuenta`). Acá la
          // base es el subtotal de la factura que se está reversando.
          baseGravable: subtotal,
          debito: totalIva,
          credito: 0,
        });
      }
      lineasAsiento.push({
        cuentaId: cuentaCartera.id,
        terceroId: factura.tercero_id,
        debito: 0,
        credito: total,
      });

      const documentoId = randomUUID();
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
            factura.subtotal,
            factura.total_iva,
            factura.total,
            asiento.id,
            ctx.usuarioId,
          ],
        ),
      );
      if (documento === undefined) {
        throw new BadRequestException('No se pudo crear la nota crédito.');
      }

      // Copia las líneas de la factura tal cual — misma cantidad, mismo
      // precio: esta nota crédito es una reversión completa, no negocia
      // nada nuevo. `costo_unitario` se omite: no toca el kardex.
      const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
      for (const l of factura.lineas) {
        const insertada = fila<VentaDocumentoLineaResumen>(
          await t.query(
            `INSERT INTO venta_documento_linea
               (empresa_id, venta_documento_id, orden, producto_id, cantidad,
                precio_unitario, iva_tarifa, subtotal, iva_valor, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING ${CAMPOS_LINEA}`,
            [
              ctx.empresaId,
              documento.id,
              l.orden,
              l.producto_id,
              l.cantidad,
              l.precio_unitario,
              l.iva_tarifa,
              l.subtotal,
              l.iva_valor,
              l.total,
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
    });
  }
}
