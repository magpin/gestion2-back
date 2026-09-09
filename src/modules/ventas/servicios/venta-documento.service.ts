import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { CrearCotizacionDto } from '../dto/cotizacion.dto';
import type { ListarVentasDto } from '../dto/venta.dto';
import { calcularLineas, type LineaVentaEntrada } from './venta.reglas';

export interface VentaDocumentoResumen {
  id: string;
  tipo: string;
  tercero_id: string;
  fecha: string;
  estado: string;
  prefijo: string | null;
  consecutivo: number;
  resolucion_id: string | null;
  documento_origen_id: string | null;
  subtotal: string;
  total_iva: string;
  total: string;
  asiento_id: string | null;
}

export interface VentaDocumentoLineaResumen {
  id: string;
  venta_documento_id: string;
  orden: number;
  producto_id: string;
  cantidad: string;
  precio_unitario: string;
  iva_tarifa: string;
  subtotal: string;
  iva_valor: string;
  total: string;
  costo_unitario: string | null;
}

export interface VentaDocumentoDetalle extends VentaDocumentoResumen {
  lineas: VentaDocumentoLineaResumen[];
}

const CAMPOS_DOCUMENTO = `id, tipo, tercero_id, fecha, estado, prefijo, consecutivo,
                           resolucion_id, documento_origen_id, subtotal, total_iva, total, asiento_id`;

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario`;

/** Fijo en código: una cotización no es un dato fiscal que alguien elija. */
const PREFIJO_COTIZACION = 'COT';

/**
 * El CRUD de cotización: crear, listar, consultar. Convertir una a factura
 * es de `FacturaService` (paso 7) — necesita `InventarioApi.costearSalida`
 * y `ContabilidadApi.asentar`, que este servicio deliberadamente no toca.
 *
 * Una cotización no asienta ni mueve el kardex: el precio de cada línea es
 * siempre el vigente del catálogo (nunca lo que mande el cliente — ver
 * "Descuentos por línea o por documento" en `ventas-backend.md`), pero de
 * ahí no sale ningún movimiento de inventario ni ningún asiento.
 */
@Injectable()
export class VentaDocumentoService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  async crearCotizacion(
    ctx: CtxEmpresa,
    dto: CrearCotizacionDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const tercero = await this.nucleo.buscarTercero(ctx, dto.terceroId, t);
      if (tercero === null || !tercero.activo) {
        throw new NotFoundException('Tercero no encontrado o inactivo.');
      }
      if (!tercero.esCliente) {
        throw new BadRequestException(
          'Este tercero no está marcado como cliente.',
        );
      }

      // Se decide UNA vez, para todas las líneas: si la empresa no es
      // responsable de IVA, ninguna línea liquida IVA, sin importar la
      // tarifa que tenga cada producto en su ficha.
      const responsableIva = await this.nucleo.esResponsableDeIva(
        ctx,
        dto.fecha,
        t,
      );

      const entradas: LineaVentaEntrada[] = [];
      for (const l of dto.lineas) {
        const producto = await this.inventario.producto(ctx, l.productoId, t);
        if (producto === null || !producto.activo) {
          throw new BadRequestException(
            `El producto ${l.productoId} no existe o está inactivo.`,
          );
        }

        const precioVigente = await this.inventario.precioVigente(
          ctx,
          l.productoId,
          t,
        );
        if (precioVigente === null) {
          throw new BadRequestException(
            `El producto ${producto.codigo} no tiene un precio de venta configurado.`,
          );
        }

        entradas.push({
          cantidad: l.cantidad,
          precioUnitario: precioVigente,
          ivaTarifa: responsableIva ? Number(producto.iva_tarifa) : 0,
        });
      }

      const { lineas, totales } = calcularLineas(entradas);
      const consecutivo = await this.siguienteConsecutivoCotizacion(
        ctx.empresaId,
        t,
      );

      const documento = fila<VentaDocumentoResumen>(
        await t.query(
          `INSERT INTO venta_documento
             (empresa_id, tipo, tercero_id, fecha, prefijo, consecutivo,
              subtotal, total_iva, total, creado_por)
           VALUES ($1, 'COTIZACION', $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${CAMPOS_DOCUMENTO}`,
          [
            ctx.empresaId,
            dto.terceroId,
            dto.fecha,
            PREFIJO_COTIZACION,
            consecutivo,
            totales.subtotal,
            totales.totalIva,
            totales.total,
            ctx.usuarioId,
          ],
        ),
      );
      if (documento === undefined) {
        throw new BadRequestException('No se pudo crear la cotización.');
      }

      const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        const productoId = dto.lineas[i].productoId;
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
              i + 1,
              productoId,
              l.cantidad,
              l.precioUnitario,
              l.ivaTarifa,
              l.subtotal,
              l.ivaValor,
              l.total,
            ],
          ),
        );
        if (insertada === undefined) {
          throw new BadRequestException(
            'No se pudo registrar una línea de la cotización.',
          );
        }
        lineasInsertadas.push(insertada);
      }

      return { ...documento, lineas: lineasInsertadas };
    });
  }

  /**
   * Los documentos de UN tipo, sin sus líneas — para el listado. Genérico a
   * propósito: `CotizacionesController` y `FacturasController` llaman al
   * mismo método con `tipo` distinto, en vez de duplicar la consulta.
   */
  async listar(
    ctx: CtxEmpresa,
    tipo: 'COTIZACION' | 'FACTURA' | 'NOTA_CREDITO',
    p: ListarVentasDto,
  ): Promise<Pagina<VentaDocumentoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = ['tipo = $1'];
      const params: unknown[] = [tipo];

      if (p.terceroId !== undefined) {
        params.push(p.terceroId);
        condiciones.push(`tercero_id = $${params.length}`);
      }

      const where = `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM venta_documento ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<VentaDocumentoResumen>(
        await t.query(
          `SELECT ${CAMPOS_DOCUMENTO}
             FROM venta_documento
             ${where}
            ORDER BY consecutivo DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /**
   * Un documento de UN tipo, con sus líneas. `tx` opcional: `NotaCreditoService`
   * lo llama desde dentro de su propia transacción para leer la factura que
   * va a corregir — sin esto, abriría una transacción aparte y perdería el
   * candado y el contexto de la que ya tiene abierta.
   */
  async porId(
    ctx: CtxEmpresa,
    tipo: 'COTIZACION' | 'FACTURA' | 'NOTA_CREDITO',
    id: string,
    tx?: Tx,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const documento = fila<VentaDocumentoResumen>(
          await t.query(
            `SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
              WHERE id = $1 AND tipo = $2`,
            [id, tipo],
          ),
        );
        if (documento === undefined) {
          throw new NotFoundException('Documento no encontrado');
        }

        const lineas = filas<VentaDocumentoLineaResumen>(
          await t.query(
            `SELECT ${CAMPOS_LINEA} FROM venta_documento_linea
              WHERE venta_documento_id = $1
              ORDER BY orden`,
            [id],
          ),
        );

        return { ...documento, lineas };
      },
      tx,
    );
  }

  /**
   * Anula una factura o nota crédito: anula su asiento y marca el
   * documento en la MISMA transacción — las dos cosas se confirman juntas
   * o ninguna. Una cotización no pasa por acá: no tiene asiento que anular,
   * y "descartarla" no es un hecho que valga la pena auditar como estos dos.
   */
  async anular(ctx: CtxEmpresa, id: string, motivo: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const documento = fila<{
        tipo: string;
        estado: string;
        asiento_id: string | null;
      }>(
        await t.query(
          `SELECT tipo, estado, asiento_id FROM venta_documento WHERE id = $1`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Documento no encontrado');
      }
      if (documento.tipo === 'COTIZACION') {
        throw new BadRequestException(
          'Una cotización no se anula: se deja como está o se hace otra.',
        );
      }
      if (documento.estado === 'ANULADA') {
        throw new BadRequestException('Este documento ya está anulado.');
      }

      // `asiento_id` no puede ser NULL acá: `ck_venta_fiscal` lo exige para
      // todo tipo que no sea COTIZACION, y ya se descartó ese caso arriba.
      await this.contabilidad.anular(
        ctx,
        documento.asiento_id as string,
        motivo,
        t,
      );

      await t.query(
        `UPDATE venta_documento
            SET estado = 'ANULADA', motivo_anulacion = $2,
                anulado_en = now(), anulado_por = $3
          WHERE id = $1`,
        [id, motivo, ctx.usuarioId],
      );
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * El siguiente número de cotización. La fila del contador se crea al
   * vuelo si es la primera vez —no hay un paso de "sembrar" para esto, a
   * diferencia de los comprobantes de `contabilidad`— y `UPDATE ...
   * RETURNING` es el candado: dos cotizaciones simultáneas se serializan
   * igual que ya lo hace `ComprobanteService.siguienteNumero`.
   */
  private async siguienteConsecutivoCotizacion(
    empresaId: string,
    t: Tx,
  ): Promise<number> {
    await t.query(
      `INSERT INTO venta_cotizacion_consecutivo (empresa_id)
       VALUES ($1)
       ON CONFLICT (empresa_id) DO NOTHING`,
      [empresaId],
    );

    const tomado = fila<{ consecutivo_actual: number }>(
      await t.query(
        `UPDATE venta_cotizacion_consecutivo
            SET consecutivo_actual = consecutivo_actual + 1
          WHERE empresa_id = $1
        RETURNING consecutivo_actual`,
        [empresaId],
      ),
    );
    if (tomado === undefined) {
      throw new BadRequestException('No se pudo numerar la cotización.');
    }
    return Number(tomado.consecutivo_actual);
  }
}
