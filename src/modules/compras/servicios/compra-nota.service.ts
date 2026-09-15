import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { esFechaFutura } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type {
  CrearNotaCreditoCompraDto,
  CrearNotaDebitoCompraDto,
} from '../dto/nota-compra.dto';
import { calcularLineasCompra, netoAPagar } from './compra.reglas';
import {
  CompraService,
  type CompraDocumentoDetalle,
  type CompraDocumentoLineaResumen,
  type CompraDocumentoResumen,
} from './compra.service';

const CAMPOS_DOCUMENTO = `id, tipo, tercero_id, fecha, numero_factura_proveedor, estado,
                           subtotal, total_iva, total, total_retenciones, neto_a_pagar,
                           monto_pagado, documento_origen_id, asiento_id,
                           (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.segundo_nombre, x.primer_apellido, x.segundo_apellido))
                              FROM tercero x WHERE x.id = tercero_id) AS tercero_nombre`;

const CAMPOS_LINEA = `id, compra_documento_id, orden, producto_id, cantidad,
                       costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre`;

const CODIGO_CUENTA_PROVEEDORES = '220505';
const CODIGO_CUENTA_IVA_DESCONTABLE = '240810';
const CODIGO_COMPROBANTE_COMPRA = 'CE';

/**
 * Las dos notas de compra, con su naturaleza invertida.
 *
 * * **Nota crédito**: el proveedor nos acredita —una devolución, un descuento
 *   posterior, un menor valor— y baja lo que se le debe. Es el asiento de la
 *   compra al revés: débito a proveedores, crédito a inventario y al IVA
 *   descontable, y las retenciones se reversan en la proporción devuelta
 *   (lo retenido se le debe a la DIAN, y si la compra baja, baja también).
 * * **Nota débito**: el proveedor nos cobra más —un flete, un interés, un
 *   mayor valor— y sube lo que se le debe. Mismo sentido que la compra.
 *
 * **Ninguna de las dos mueve el kardex**, igual que las notas de venta (ver
 * "Qué NO entra" en `docs/planes/ventas-ajustes.md`). Ojo con lo que eso
 * implica en compras, que es más fuerte que en ventas: si la mercancía vuelve
 * físicamente al proveedor, el libro deja de contarla y el kardex sigue con
 * ella hasta que alguien registre la salida de ajuste. Está anotado como el
 * punto a revisar del plan: `CompraService.anular` ya resuelve el caso
 * equivalente moviendo el kardex en el mismo acto, y estas dos notas deberían
 * terminar haciendo lo mismo.
 */
@Injectable()
export class CompraNotaService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly compras: CompraService,
  ) {}

  // ---------------------------------------------------------------------------
  // Nota crédito: el proveedor nos acredita
  // ---------------------------------------------------------------------------
  async crearNotaCredito(
    ctx: CtxEmpresa,
    dto: CrearNotaCreditoCompraDto,
  ): Promise<CompraDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const compra = await this.exigirCompraVigente(ctx, dto, t);

      // Qué se devuelve, y a qué costo: el de la compra, no uno nuevo.
      const yaDevuelto = await this.devueltoPorLinea(
        compra.lineas.map((l) => l.id),
        t,
      );
      const pedido =
        dto.lineas ??
        compra.lineas
          .map((l) => ({
            lineaOrigenId: l.id,
            cantidad: Number(l.cantidad) - (yaDevuelto.get(l.id) ?? 0),
          }))
          .filter((l) => l.cantidad > 0);

      const porId = new Map(compra.lineas.map((l) => [l.id, l]));
      const origenes: CompraDocumentoLineaResumen[] = [];
      const entradas = [];
      for (const p of pedido) {
        const original = porId.get(p.lineaOrigenId);
        if (original === undefined) {
          throw new BadRequestException(
            'Una de las líneas que querés devolver no es de esta compra.',
          );
        }
        const pendiente =
          Number(original.cantidad) - (yaDevuelto.get(p.lineaOrigenId) ?? 0);
        if (p.cantidad > pendiente) {
          throw new BadRequestException(
            `De esa línea quedan ${pendiente} por devolver de las ${Number(original.cantidad)} compradas; no se pueden devolver ${p.cantidad}.`,
          );
        }
        origenes.push(original);
        entradas.push({
          cantidad: p.cantidad,
          costoUnitario: Number(original.costo_unitario),
          ivaTarifa: Number(original.iva_tarifa),
          ivaDescontable: original.iva_descontable,
        });
      }
      if (entradas.length === 0) {
        throw new BadRequestException(
          'Esta compra ya se devolvió completa: no queda nada por acreditar.',
        );
      }

      const { lineas, totales } = calcularLineasCompra(entradas);

      // Las retenciones bajan en la misma proporción que el total: lo que se
      // le retuvo al proveedor por una compra que se devolvió en parte ya no
      // se le debe a la DIAN en esa parte.
      const proporcion = totales.total / Number(compra.total);
      const retenciones = compra.retenciones.map((r) => ({
        concepto: r.concepto,
        cuentaId: r.cuenta_id,
        base: redondear2(Number(r.base) * proporcion),
        valor: redondear2(Number(r.valor) * proporcion),
      }));
      const retenido = redondear2(retenciones.reduce((s, r) => s + r.valor, 0));
      const neto = netoAPagar(totales.total, retenido);

      const { cuentaProveedores, cuentaIvaId, totalIvaDescontable } =
        await this.cuentas(ctx, lineas, totales.subtotal, t);

      const cuentaInventarioDe = await this.cuentasDeInventario(
        ctx,
        origenes.map((l) => l.producto_id),
        t,
      );

      // El asiento de la compra, al revés.
      const lineasAsiento: LineaAsientoDto[] = [
        {
          cuentaId: cuentaProveedores.id,
          terceroId: compra.tercero_id,
          debito: neto,
          credito: 0,
        },
      ];
      for (const r of retenciones) {
        if (r.valor <= 0) continue;
        lineasAsiento.push({
          cuentaId: r.cuentaId,
          terceroId: compra.tercero_id,
          baseGravable: r.base,
          debito: r.valor,
          credito: 0,
        });
      }
      lineas.forEach((l, i) => {
        lineasAsiento.push({
          cuentaId: cuentaInventarioDe[i],
          debito: 0,
          credito: l.valorKardex,
        });
      });
      if (cuentaIvaId !== null) {
        lineasAsiento.push({
          cuentaId: cuentaIvaId,
          baseGravable: totales.subtotal,
          debito: 0,
          credito: totalIvaDescontable,
        });
      }

      return this.guardar(
        ctx,
        'NOTA_CREDITO',
        dto,
        compra,
        { lineas, totales, retenido, neto, retenciones },
        origenes.map((l) => l.producto_id),
        origenes.map((l) => l.id),
        lineasAsiento,
        t,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Nota débito: el proveedor nos cobra más
  // ---------------------------------------------------------------------------
  async crearNotaDebito(
    ctx: CtxEmpresa,
    dto: CrearNotaDebitoCompraDto,
  ): Promise<CompraDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const compra = await this.exigirCompraVigente(ctx, dto, t);

      const productoIds = dto.lineas.map((l) => l.productoId);
      if (new Set(productoIds).size !== productoIds.length) {
        throw new BadRequestException(
          'No repitas el mismo producto en dos líneas — sumá la cantidad en una sola.',
        );
      }

      // Las dos preguntas de siempre (decisión 4 del plan de compras): el IVA
      // de la línea lo pone el proveedor, y que sea descontable lo decide
      // nuestra condición. Se heredan de la compra que se está corrigiendo.
      const ivaDescontable = compra.lineas.some((l) => l.iva_descontable);
      const entradas = [];
      for (const l of dto.lineas) {
        const producto = await this.inventario.producto(ctx, l.productoId, t);
        if (producto === null || !producto.activo) {
          throw new BadRequestException(
            `El producto ${l.productoId} no existe o está inactivo.`,
          );
        }
        entradas.push({
          cantidad: l.cantidad,
          costoUnitario: l.costoUnitario,
          ivaTarifa: Number(producto.iva_tarifa),
          ivaDescontable,
        });
      }

      const { lineas, totales } = calcularLineasCompra(entradas);
      // Sin retenciones: lo que el proveedor cobra después se retiene, si
      // hace falta, en el documento que corresponda — no acá. Queda anotado
      // en el plan como lo que no entra de este corte.
      const neto = netoAPagar(totales.total, 0);

      const { cuentaProveedores, cuentaIvaId, totalIvaDescontable } =
        await this.cuentas(ctx, lineas, totales.subtotal, t);
      const cuentaInventarioDe = await this.cuentasDeInventario(
        ctx,
        productoIds,
        t,
      );

      // Mismo sentido que la compra: débito lo que entra, crédito lo que se
      // debe.
      const lineasAsiento: LineaAsientoDto[] = [];
      lineas.forEach((l, i) => {
        lineasAsiento.push({
          cuentaId: cuentaInventarioDe[i],
          debito: l.valorKardex,
          credito: 0,
        });
      });
      if (cuentaIvaId !== null) {
        lineasAsiento.push({
          cuentaId: cuentaIvaId,
          baseGravable: totales.subtotal,
          debito: totalIvaDescontable,
          credito: 0,
        });
      }
      lineasAsiento.push({
        cuentaId: cuentaProveedores.id,
        terceroId: compra.tercero_id,
        debito: 0,
        credito: neto,
      });

      return this.guardar(
        ctx,
        'NOTA_DEBITO',
        dto,
        compra,
        { lineas, totales, retenido: 0, neto, retenciones: [] },
        productoIds,
        dto.lineas.map(() => null),
        lineasAsiento,
        t,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Lo compartido
  // ---------------------------------------------------------------------------

  /** La compra que la nota corrige, vigente y con su fecha razonable. */
  private async exigirCompraVigente(
    ctx: CtxEmpresa,
    dto: { documentoOrigenId: string; fecha: string },
    t: Tx,
  ): Promise<CompraDocumentoDetalle> {
    // Como la compra: acepta fecha pasada —la nota del proveedor llega con la
    // fecha que él le puso— y rechaza futuro.
    if (esFechaFutura(dto.fecha)) {
      throw new BadRequestException(
        'La fecha de la nota no puede ser posterior a hoy.',
      );
    }
    const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
      ctx,
      new Date(dto.fecha),
      t,
    );
    if (!periodoAbierto) {
      throw new BadRequestException(
        'El período de esta fecha está cerrado. No se puede registrar la nota.',
      );
    }

    const compra = await this.compras.porId(ctx, dto.documentoOrigenId, t);
    if (compra.tipo !== 'FACTURA') {
      throw new BadRequestException(
        'Una nota se registra sobre una factura de compra, no sobre otra nota.',
      );
    }
    if (compra.estado !== 'EMITIDA') {
      throw new BadRequestException(
        'Esta compra está anulada: no se le puede registrar una nota.',
      );
    }
    return compra;
  }

  /** Cuánto se devolvió ya de cada línea, por notas crédito no anuladas. */
  private async devueltoPorLinea(
    lineaIds: string[],
    t: Tx,
  ): Promise<Map<string, number>> {
    if (lineaIds.length === 0) return new Map();
    const devueltas = filas<{ linea_origen_id: string; cantidad: string }>(
      await t.query(
        `SELECT l.linea_origen_id, sum(l.cantidad)::text AS cantidad
           FROM compra_documento_linea l
           JOIN compra_documento d ON d.id = l.compra_documento_id
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

  private async cuentas(
    ctx: CtxEmpresa,
    lineas: Array<{ ivaDescontable: boolean; ivaValor: number }>,
    subtotal: number,
    t: Tx,
  ): Promise<{
    cuentaProveedores: { id: string };
    cuentaIvaId: string | null;
    totalIvaDescontable: number;
  }> {
    const cuentaProveedores = await this.nucleo.cuenta(
      ctx,
      CODIGO_CUENTA_PROVEEDORES,
      t,
    );
    if (cuentaProveedores === null) {
      throw new BadRequestException(
        `No existe o está inactiva la cuenta de proveedores (${CODIGO_CUENTA_PROVEEDORES}). Actívala en el plan de cuentas.`,
      );
    }

    const totalIvaDescontable = lineas
      .filter((l) => l.ivaDescontable)
      .reduce((s, l) => s + l.ivaValor, 0);
    let cuentaIvaId: string | null = null;
    if (totalIvaDescontable > 0) {
      const cuentaIva = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_IVA_DESCONTABLE,
        t,
      );
      if (cuentaIva === null) {
        throw new BadRequestException(
          `No existe o está inactiva la cuenta de IVA descontable (${CODIGO_CUENTA_IVA_DESCONTABLE}). Actívala en el plan de cuentas.`,
        );
      }
      cuentaIvaId = cuentaIva.id;
    }
    void subtotal;
    return { cuentaProveedores, cuentaIvaId, totalIvaDescontable };
  }

  private async cuentasDeInventario(
    ctx: CtxEmpresa,
    productoIds: string[],
    t: Tx,
  ): Promise<string[]> {
    const cuentas: string[] = [];
    for (const id of productoIds) {
      const producto = await this.inventario.producto(ctx, id, t);
      if (producto === null) {
        throw new BadRequestException(`El producto ${id} no existe.`);
      }
      cuentas.push(producto.cuenta_inventario_id);
    }
    return cuentas;
  }

  /** El asiento, la cabecera, las líneas y las retenciones de la nota. */
  private async guardar(
    ctx: CtxEmpresa,
    tipo: 'NOTA_CREDITO' | 'NOTA_DEBITO',
    dto: {
      documentoOrigenId: string;
      fecha: string;
      numeroNotaProveedor: string;
      motivo: string;
    },
    compra: CompraDocumentoDetalle,
    calculo: {
      lineas: Array<{
        cantidad: number;
        costoUnitario: number;
        ivaTarifa: number;
        subtotal: number;
        ivaValor: number;
        total: number;
        ivaDescontable: boolean;
      }>;
      totales: { subtotal: number; totalIva: number; total: number };
      retenido: number;
      neto: number;
      retenciones: Array<{
        concepto: string;
        cuentaId: string;
        base: number;
        valor: number;
      }>;
    },
    productoIds: string[],
    lineaOrigenIds: Array<string | null>,
    lineasAsiento: LineaAsientoDto[],
    t: Tx,
  ): Promise<CompraDocumentoDetalle> {
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE_COMPRA,
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de egreso sembrado.',
      );
    }

    const documentoId = randomUUID();
    const etiqueta = tipo === 'NOTA_CREDITO' ? 'Nota crédito' : 'Nota débito';
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: dto.fecha,
        glosa: `${etiqueta} de compra ${dto.numeroNotaProveedor} — factura ${compra.numero_factura_proveedor}: ${dto.motivo}`,
        lineas: lineasAsiento,
      },
      { origenTipo: 'COMPRA', origenId: documentoId },
      t,
    );

    const documento = fila<CompraDocumentoResumen>(
      await t.query(
        `INSERT INTO compra_documento
           (id, empresa_id, tipo, tercero_id, fecha, numero_factura_proveedor,
            documento_origen_id, subtotal, total_iva, total, total_retenciones,
            neto_a_pagar, asiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${CAMPOS_DOCUMENTO}`,
        [
          documentoId,
          ctx.empresaId,
          tipo,
          compra.tercero_id,
          dto.fecha,
          dto.numeroNotaProveedor,
          dto.documentoOrigenId,
          calculo.totales.subtotal,
          calculo.totales.totalIva,
          calculo.totales.total,
          calculo.retenido,
          calculo.neto,
          asiento.id,
          ctx.usuarioId,
        ],
      ),
    );
    if (documento === undefined) {
      throw new BadRequestException(`No se pudo registrar la ${etiqueta}.`);
    }

    const lineasInsertadas: CompraDocumentoLineaResumen[] = [];
    for (let i = 0; i < calculo.lineas.length; i++) {
      const l = calculo.lineas[i];
      const insertada = fila<CompraDocumentoLineaResumen>(
        await t.query(
          `INSERT INTO compra_documento_linea
             (empresa_id, compra_documento_id, orden, producto_id, cantidad,
              costo_unitario, iva_tarifa, subtotal, iva_valor, total,
              iva_descontable, linea_origen_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING ${CAMPOS_LINEA}`,
          [
            ctx.empresaId,
            documento.id,
            i + 1,
            productoIds[i],
            l.cantidad,
            l.costoUnitario,
            l.ivaTarifa,
            l.subtotal,
            l.ivaValor,
            l.total,
            l.ivaDescontable,
            lineaOrigenIds[i],
          ],
        ),
      );
      if (insertada === undefined) {
        throw new BadRequestException(
          `No se pudo registrar una línea de la ${etiqueta}.`,
        );
      }
      lineasInsertadas.push(insertada);
    }

    for (const r of calculo.retenciones) {
      if (r.valor <= 0) continue;
      await t.query(
        `INSERT INTO compra_retencion
           (empresa_id, compra_documento_id, concepto, cuenta_id, base, valor)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.empresaId, documento.id, r.concepto, r.cuentaId, r.base, r.valor],
      );
    }

    return this.compras.porId(ctx, documento.id, t);
  }
}

/** Los pesos de las notas se redondean igual que en el resto del sistema. */
function redondear2(valor: number): number {
  return Math.round(valor * 100) / 100;
}
