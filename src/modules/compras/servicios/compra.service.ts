import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { esFechaFutura, hoyEnColombia } from '../../../common/fecha';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type {
  CrearCompraDto,
  DevolverPagoDto,
  ListarComprasDto,
  PagarDto,
  RetencionCompraDto,
} from '../dto/compra.dto';
import {
  calcularDevolucionPago,
  calcularLineasCompra,
  calcularPago,
  netoAPagar,
  sumarPagos,
  totalRetenciones,
} from './compra.reglas';
import type { LineaCompraEntrada } from './compra.reglas';

export interface CompraDocumentoResumen {
  id: string;
  /** FACTURA, o una de las dos notas — ver migración `0039`. */
  tipo: 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
  /** La factura que la nota corrige. `null` en una factura. */
  documento_origen_id: string | null;
  tercero_id: string;
  tercero_nombre: string;
  /** Ya formateada para mostrar: `NIT 900123456-7`, `CC 19400748`. */
  tercero_identificacion: string;
  fecha: string;
  numero_factura_proveedor: string;
  estado: string;
  subtotal: string;
  total_iva: string;
  total: string;
  total_retenciones: string;
  neto_a_pagar: string;
  /** Cuánto se le ha pagado al proveedor. */
  monto_pagado: string;
  /**
   * Lo que las notas no anuladas le sumaron o restaron: negativo por cada
   * nota crédito, positivo por cada nota débito. `neto_a_pagar +
   * ajuste_notas` es lo que realmente se le debe al proveedor.
   */
  ajuste_notas: string;
  /** `neto_a_pagar + ajuste_notas`: lo que hoy se le debe al proveedor. */
  neto_efectivo: string;
  /** Lo que falta por pagarle: `neto_efectivo - monto_pagado`, nunca negativo. */
  pendiente: string;
  /**
   * Lo pagado de más, cuando una compra ya pagada recibe después una nota
   * crédito del proveedor: plata que él tiene que devolver. Ver
   * `saldo_a_favor` en ventas, que es el mismo caso del otro lado.
   */
  saldo_a_favor: string;
  asiento_id: string;
}

export interface CompraDocumentoLineaResumen {
  id: string;
  compra_documento_id: string;
  orden: number;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  cantidad: string;
  costo_unitario: string;
  iva_tarifa: string;
  subtotal: string;
  iva_valor: string;
  total: string;
  iva_descontable: boolean;
}

export interface CompraRetencionResumen {
  id: string;
  compra_documento_id: string;
  concepto: string;
  cuenta_id: string;
  base: string;
  valor: string;
}

export interface CompraDocumentoDetalle extends CompraDocumentoResumen {
  /** En una nota: la factura del proveedor que corrige. */
  documento_origen?: CompraDocumentoResumen | null;
  /** En una factura: las notas del proveedor que le apuntan. */
  notas?: CompraDocumentoResumen[];
  lineas: CompraDocumentoLineaResumen[];
  retenciones: CompraRetencionResumen[];
}

/** Lo que las notas del proveedor le movieron. Ver `AJUSTE_NOTAS` en ventas. */
const AJUSTE_NOTAS = `(SELECT coalesce(sum(CASE WHEN n.tipo = 'NOTA_CREDITO' THEN -n.neto_a_pagar ELSE n.neto_a_pagar END), 0)
                         FROM compra_documento n
                        WHERE n.documento_origen_id = compra_documento.id
                          AND n.estado <> 'ANULADA')`;

/** Los dos lados del neto efectivo. Ver `SALDO_EFECTIVO` en ventas. */
const NETO_EFECTIVO = `(neto_a_pagar + ${AJUSTE_NOTAS})`;
const PENDIENTE = `greatest(${NETO_EFECTIVO} - monto_pagado, 0)`;
const SALDO_A_FAVOR = `greatest(monto_pagado - ${NETO_EFECTIVO}, 0)`;

// Mismo criterio que `VentaDocumentoService`: el nombre y la identificación
// viajan con el documento, y el porqué está escrito allá.
const IDENTIFICACION_TERCERO = `(SELECT concat_ws(' ', x.tipo_documento,
                                        x.numero_documento || coalesce('-' || x.dv, ''))
                                   FROM tercero x WHERE x.id = tercero_id)`;

// Se exporta por lo mismo que en ventas: `CompraNotaService` devuelve este
// mismo resumen desde su `RETURNING` y tenía su propia copia de la lista.
export const CAMPOS_DOCUMENTO = `id, tipo, documento_origen_id,
                           tercero_id, fecha, numero_factura_proveedor, estado,
                           subtotal, total_iva, total, total_retenciones, neto_a_pagar,
                           monto_pagado, asiento_id,
                           (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.segundo_nombre, x.primer_apellido, x.segundo_apellido))
                              FROM tercero x WHERE x.id = tercero_id) AS tercero_nombre,
                           ${IDENTIFICACION_TERCERO} AS tercero_identificacion,
                           ${AJUSTE_NOTAS} AS ajuste_notas,
                           ${NETO_EFECTIVO} AS neto_efectivo,
                           ${PENDIENTE} AS pendiente,
                           ${SALDO_A_FAVOR} AS saldo_a_favor`;

const CAMPOS_LINEA = `id, compra_documento_id, orden, producto_id, cantidad,
                       costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre`;

const CAMPOS_RETENCION = `id, compra_documento_id, concepto, cuenta_id, base, valor`;

/** [BASE], suscrito a rango libre: `libre('2205','05', ...)` en `plan-cuentas.reglas.ts`. */
const CODIGO_CUENTA_PROVEEDORES = '220505';
/** [COND si responsable de IVA] */
const CODIGO_CUENTA_IVA_DESCONTABLE = '240810';
/** Comprobante de egreso — simétrico a como Ventas usa `CI` aunque sea a crédito. */
const CODIGO_COMPROBANTE_COMPRA = 'CE';

/** El sufijo de `2365{sufijo}` para cada concepto — mismos seis que siembra `plan-cuentas.reglas.ts`. */
const SUFIJO_CONCEPTO_RETENCION: Record<string, string> = {
  HONORARIOS: '15',
  COMISIONES: '20',
  SERVICIOS: '25',
  ARRENDAMIENTOS: '30',
  COMPRAS: '40',
  OTROS: '70',
};

/**
 * Registra la factura de compra: el único servicio de `compras` que
 * asienta y mueve el kardex. Todo en una sola transacción, en este orden:
 *
 *   1. Período abierto.
 *   2. Proveedor y, por línea, el producto — sin costear nada antes: el
 *      costo de una entrada es un dato de la factura, no algo que dependa
 *      del saldo actual (a diferencia de una venta). Ver
 *      `docs/planes/compras-backend.md`, decisión 7.
 *   3. Resuelve cuentas (proveedores, IVA descontable si aplica,
 *      retenciones si las hay) y arma el asiento completo con
 *      `ContabilidadApi.asentar`.
 *   4. Inserta la compra, sus líneas y sus retenciones, con el
 *      `asiento_id` ya resuelto.
 *   5. `InventarioApi.incrementarPorCompra` por línea — recién ahora
 *      escribe el kardex.
 */
@Injectable()
export class CompraService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly tesoreria: TesoreriaApi,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearCompraDto,
  ): Promise<CompraDocumentoDetalle> {
    if (esFechaFutura(dto.fecha)) {
      throw new BadRequestException(
        'La fecha de la compra no puede ser posterior a hoy.',
      );
    }
    const productoIds = dto.lineas.map((l) => l.productoId);
    if (new Set(productoIds).size !== productoIds.length) {
      throw new BadRequestException(
        'No repitas el mismo producto en dos líneas — sumá la cantidad en una sola.',
      );
    }

    const retenciones = dto.retenciones ?? [];
    const conceptos = retenciones.map((r) => r.concepto);
    if (new Set(conceptos).size !== conceptos.length) {
      throw new BadRequestException(
        'No repitas el mismo concepto de retención dos veces en la misma compra.',
      );
    }

    return this.tx.enContexto(ctx, async (t) => {
      const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
        ctx,
        new Date(dto.fecha),
        t,
      );
      if (!periodoAbierto) {
        throw new BadRequestException(
          'El período de esta fecha está cerrado. No se puede registrar la compra.',
        );
      }

      const proveedor = await this.nucleo.buscarTercero(ctx, dto.terceroId, t);
      if (proveedor === null || !proveedor.activo) {
        throw new NotFoundException('Tercero no encontrado o inactivo.');
      }
      if (!proveedor.esProveedor) {
        throw new BadRequestException(
          'Este tercero no está marcado como proveedor.',
        );
      }

      // Dos preguntas distintas (decisión 4 del plan): ¿hay IVA en la
      // línea? lo decide el PROVEEDOR. ¿ese IVA es descontable? lo decide
      // nuestra propia condición.
      const responsableIva = await this.regimenIncluye(ctx, dto.fecha, t, [
        'RESPONSABLE_IVA',
      ]);

      const entradas: LineaCompraEntrada[] = [];
      const cuentaInventarioDe: string[] = [];

      for (const l of dto.lineas) {
        const producto = await this.inventario.producto(ctx, l.productoId, t);
        if (producto === null || !producto.activo) {
          throw new BadRequestException(
            `El producto ${l.productoId} no existe o está inactivo.`,
          );
        }

        cuentaInventarioDe.push(producto.cuenta_inventario_id);
        entradas.push({
          cantidad: l.cantidad,
          costoUnitario: l.costoUnitario,
          ivaTarifa: proveedor.responsableIva ? Number(producto.iva_tarifa) : 0,
          ivaDescontable: responsableIva,
        });
      }

      const { lineas, totales } = calcularLineasCompra(entradas);

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

      let cuentaIvaId: string | null = null;
      const totalIvaDescontable = lineas
        .filter((l) => l.ivaDescontable)
        .reduce((t2, l) => t2 + l.ivaValor, 0);
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

      const retencionesResueltas = await this.resolverRetenciones(
        ctx,
        retenciones,
        totales.total,
        dto.fecha,
        t,
      );
      const retenido = totalRetenciones(retenciones);
      const neto = netoAPagar(totales.total, retenido);

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

      // El asiento: débito inventario por línea (con el IVA no descontable
      // ya prorrateado adentro si corresponde), débito IVA descontable si
      // aplica, crédito retención por concepto si hay, crédito proveedores
      // por el neto — ver decisión 6 del plan.
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
      for (const r of retencionesResueltas) {
        lineasAsiento.push({
          cuentaId: r.cuentaId,
          terceroId: dto.terceroId,
          baseGravable: r.base,
          debito: 0,
          credito: r.valor,
        });
      }
      lineasAsiento.push({
        cuentaId: cuentaProveedores.id,
        terceroId: dto.terceroId,
        debito: 0,
        credito: neto,
      });

      const documentoId = randomUUID();

      const asiento = await this.contabilidad.asentar(
        ctx,
        {
          comprobanteTipoId: comprobante.id,
          fecha: dto.fecha,
          glosa: `Factura de compra ${dto.numeroFacturaProveedor}`,
          lineas: lineasAsiento,
        },
        { origenTipo: 'COMPRA', origenId: documentoId },
        t,
      );

      const documento = fila<CompraDocumentoResumen>(
        await t.query(
          `INSERT INTO compra_documento
             (id, empresa_id, tercero_id, fecha, numero_factura_proveedor,
              subtotal, total_iva, total, total_retenciones, neto_a_pagar,
              asiento_id, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING ${CAMPOS_DOCUMENTO}`,
          [
            documentoId,
            ctx.empresaId,
            dto.terceroId,
            dto.fecha,
            dto.numeroFacturaProveedor,
            totales.subtotal,
            totales.totalIva,
            totales.total,
            retenido,
            neto,
            asiento.id,
            ctx.usuarioId,
          ],
        ),
      );
      if (documento === undefined) {
        throw new BadRequestException('No se pudo registrar la compra.');
      }

      const lineasInsertadas: CompraDocumentoLineaResumen[] = [];
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        const insertada = fila<CompraDocumentoLineaResumen>(
          await t.query(
            `INSERT INTO compra_documento_linea
               (empresa_id, compra_documento_id, orden, producto_id, cantidad,
                costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING ${CAMPOS_LINEA}`,
            [
              ctx.empresaId,
              documento.id,
              i + 1,
              dto.lineas[i].productoId,
              l.cantidad,
              l.costoUnitario,
              l.ivaTarifa,
              l.subtotal,
              l.ivaValor,
              l.total,
              l.ivaDescontable,
            ],
          ),
        );
        if (insertada === undefined) {
          throw new BadRequestException(
            'No se pudo registrar una línea de la compra.',
          );
        }
        lineasInsertadas.push(insertada);
      }

      const retencionesInsertadas: CompraRetencionResumen[] = [];
      for (const r of retencionesResueltas) {
        const insertada = fila<CompraRetencionResumen>(
          await t.query(
            `INSERT INTO compra_retencion
               (empresa_id, compra_documento_id, concepto, cuenta_id, base, valor)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING ${CAMPOS_RETENCION}`,
            [
              ctx.empresaId,
              documento.id,
              r.concepto,
              r.cuentaId,
              r.base,
              r.valor,
            ],
          ),
        );
        if (insertada === undefined) {
          throw new BadRequestException(
            'No se pudo registrar una retención de la compra.',
          );
        }
        retencionesInsertadas.push(insertada);
      }

      // Recién ahora se escribe el kardex — el asiento y la compra ya
      // existen, así que `incrementarPorCompra` los enlaza, no los adivina.
      for (let i = 0; i < lineas.length; i++) {
        await this.inventario.incrementarPorCompra(
          ctx,
          dto.lineas[i].productoId,
          lineas[i].cantidad,
          lineas[i].costoUnitarioKardex,
          dto.fecha,
          `Factura de compra ${dto.numeroFacturaProveedor}`,
          asiento.id,
          t,
        );
      }

      return {
        ...documento,
        lineas: lineasInsertadas,
        retenciones: retencionesInsertadas,
      };
    });
  }

  /** Las compras, sin sus líneas ni retenciones — para el listado. */
  /**
   * Los documentos de compra de un tipo. `tipo` por defecto es `FACTURA`:
   * desde `0039` las notas viven en la misma tabla, y la pantalla de compras
   * no debería empezar a mostrarlas mezcladas de un día para otro.
   */
  async listar(
    ctx: CtxEmpresa,
    p: ListarComprasDto,
    tipo: 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO' = 'FACTURA',
  ): Promise<Pagina<CompraDocumentoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      params.push(tipo);
      condiciones.push(`tipo = $${params.length}`);

      if (p.terceroId !== undefined) {
        params.push(p.terceroId);
        condiciones.push(`tercero_id = $${params.length}`);
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM compra_documento ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<CompraDocumentoResumen>(
        await t.query(
          `SELECT ${CAMPOS_DOCUMENTO}
             FROM compra_documento
             ${where}
            ORDER BY fecha DESC, creado_en DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /** Una compra, con sus líneas y retenciones. `tx` opcional, mismo criterio que `VentaDocumentoService.porId`. */
  async porId(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<CompraDocumentoDetalle> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const documento = fila<CompraDocumentoResumen>(
          await t.query(
            `SELECT ${CAMPOS_DOCUMENTO} FROM compra_documento WHERE id = $1`,
            [id],
          ),
        );
        if (documento === undefined) {
          throw new NotFoundException('Compra no encontrada');
        }

        const lineas = filas<CompraDocumentoLineaResumen>(
          await t.query(
            `SELECT ${CAMPOS_LINEA} FROM compra_documento_linea
              WHERE compra_documento_id = $1
              ORDER BY orden`,
            [id],
          ),
        );

        const documentoOrigen =
          documento.documento_origen_id === null
            ? null
            : (fila<CompraDocumentoResumen>(
                await t.query(
                  `SELECT ${CAMPOS_DOCUMENTO} FROM compra_documento WHERE id = $1`,
                  [documento.documento_origen_id],
                ),
              ) ?? null);

        const notas = filas<CompraDocumentoResumen>(
          await t.query(
            `SELECT ${CAMPOS_DOCUMENTO} FROM compra_documento
              WHERE documento_origen_id = $1
              ORDER BY fecha, creado_en`,
            [id],
          ),
        );

        const retenciones = filas<CompraRetencionResumen>(
          await t.query(
            `SELECT ${CAMPOS_RETENCION} FROM compra_retencion
              WHERE compra_documento_id = $1
              ORDER BY concepto`,
            [id],
          ),
        );

        return {
          ...documento,
          lineas,
          retenciones,
          documento_origen: documentoOrigen,
          notas,
        };
      },
      tx,
    );
  }

  /**
   * Anula una compra: anula su asiento y marca el documento en la MISMA
   * transacción — las dos cosas se confirman juntas o ninguna, mismo
   * patrón que `VentaDocumentoService.anular`. El kardex SÍ se revierte: la
   * mercancía de la compra sale con el mismo asiento (anulado) como
   * referencia, y si ya no está, la compra no se anula.
   */
  async anular(ctx: CtxEmpresa, id: string, motivo: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const documento = fila<{
        estado: string;
        asiento_id: string;
        monto_pagado: string;
        numero_factura_proveedor: string;
      }>(
        await t.query(
          `SELECT estado, asiento_id, monto_pagado, numero_factura_proveedor
             FROM compra_documento WHERE id = $1`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Compra no encontrada');
      }
      if (documento.estado === 'ANULADA') {
        throw new BadRequestException('Esta compra ya está anulada.');
      }
      // Mismo criterio que la factura cobrada: un pago que ya salió del
      // banco no desaparece anulando el documento que lo motivó.
      if (Number(documento.monto_pagado) > 0) {
        throw new BadRequestException(
          'Esta compra tiene pagos registrados y no se puede anular. Registrá la devolución del proveedor como un ingreso aparte.',
        );
      }

      // La mercancía que entró con la compra sale del kardex en el mismo acto.
      // Anular solo el asiento dejaba el inventario del libro sin esas
      // unidades y el kardex con ellas, y el ajuste manual que se pedía después
      // las volvía a acreditar: dos salidas contables por una sola física.
      // Si alguna unidad ya se vendió, no hay qué devolver y no se anula.
      const lineas = filas<{
        producto_id: string;
        producto_codigo: string;
        cantidad: string;
      }>(
        await t.query(
          `SELECT ${CAMPOS_LINEA} FROM compra_documento_linea
            WHERE compra_documento_id = $1 ORDER BY orden`,
          [id],
        ),
      );
      for (const l of lineas) {
        const saldo = await this.inventario.saldoActual(ctx, l.producto_id, t);
        const disponible = Number(saldo?.cantidad ?? 0);
        if (disponible < Number(l.cantidad)) {
          throw new BadRequestException(
            `De ${l.producto_codigo} entraron ${Number(l.cantidad)} con esta compra y solo quedan ${disponible}: parte ya se vendió y la compra no se puede anular.`,
          );
        }
      }

      await this.contabilidad.anular(ctx, documento.asiento_id, motivo, t);

      const hoy = hoyEnColombia();
      for (const l of lineas) {
        await this.inventario.revertirPorAnulacionCompra(
          ctx,
          l.producto_id,
          Number(l.cantidad),
          hoy,
          `Anulación de la compra ${documento.numero_factura_proveedor}: ${motivo}`,
          documento.asiento_id,
          t,
        );
      }

      await t.query(
        `UPDATE compra_documento
            SET estado = 'ANULADA', motivo_anulacion = $2,
                anulado_en = now(), anulado_por = $3
          WHERE id = $1`,
        [id, motivo, ctx.usuarioId],
      );
    });
  }

  /**
   * Paga una compra en efectivo, total o parcialmente. El pago
   * (`TesoreriaApi.registrarPago`) y la actualización de `monto_pagado`
   * se confirman en la MISMA transacción — mismo motivo que
   * `VentaDocumentoService.cobrar`.
   *
   * El `FOR UPDATE` sobre la compra es el candado: dos pagos simultáneos
   * de la misma compra no pueden leer el mismo `monto_pagado` y pisarse.
   */
  async pagar(
    ctx: CtxEmpresa,
    id: string,
    dto: PagarDto,
  ): Promise<CompraDocumentoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const documento = fila<{
        tercero_id: string;
        estado: string;
        numero_factura_proveedor: string;
        neto_a_pagar: string;
        monto_pagado: string;
        neto_efectivo: string;
      }>(
        await t.query(
          `SELECT tercero_id, estado, numero_factura_proveedor, neto_a_pagar, monto_pagado,
                  ${NETO_EFECTIVO} AS neto_efectivo
             FROM compra_documento
            WHERE id = $1
            FOR UPDATE`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Compra no encontrada');
      }
      if (documento.estado !== 'EMITIDA') {
        throw new BadRequestException('Esta compra no está vigente.');
      }

      // La suma de los renglones se valida UNA vez: ver el mismo criterio en
      // `VentaDocumentoService.cobrar`.
      const valorTotal = sumarPagos(dto.pagos.map((p) => p.valor));

      // Contra el neto efectivo: la nota crédito del proveedor baja lo que
      // se le debe, y la nota débito lo sube.
      const resultado = calcularPago(
        Number(documento.neto_efectivo),
        Number(documento.monto_pagado),
        valorTotal,
      );
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

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

      // Un movimiento por renglón, en la misma transacción — espejo de
      // `cobrar`, y el `concepto` numera el reparto solo si hay más de uno.
      for (const [i, pago] of dto.pagos.entries()) {
        const medio =
          pago.medio === 'CAJA'
            ? ({ medio: 'CAJA', cajaId: pago.cajaId! } as const)
            : ({
                medio: 'BANCO',
                cuentaBancariaId: pago.cuentaBancariaId!,
              } as const);
        const reparto =
          dto.pagos.length === 1 ? '' : ` (${i + 1} de ${dto.pagos.length})`;
        await this.tesoreria.registrarPago(
          ctx,
          {
            ...medio,
            fecha: dto.fecha,
            valor: pago.valor,
            concepto: `Pago de la compra ${documento.numero_factura_proveedor}${reparto}`,
            cuentaProveedoresId: cuentaProveedores.id,
            terceroId: documento.tercero_id,
            compraId: id,
          },
          t,
        );
      }

      const actualizado = fila<CompraDocumentoResumen>(
        await t.query(
          `UPDATE compra_documento SET monto_pagado = $2
            WHERE id = $1
          RETURNING ${CAMPOS_DOCUMENTO}`,
          [id, resultado.montoPagado],
        ),
      );
      if (actualizado === undefined) {
        throw new BadRequestException('No se pudo registrar el pago.');
      }
      return actualizado;
    });
  }

  /**
   * El proveedor nos devuelve parte de lo que le pagamos. Espejo de
   * `VentaDocumentoService.devolverCobro`, y allá está escrito por qué esto
   * no es una nota crédito.
   *
   * Acá la plata entra, así que no hay saldo de caja que se quede corto: el
   * caso que puede fallar es el del lado de ventas.
   */
  async devolverPago(
    ctx: CtxEmpresa,
    id: string,
    dto: DevolverPagoDto,
  ): Promise<CompraDocumentoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const documento = fila<{
        tercero_id: string;
        estado: string;
        numero_factura_proveedor: string;
        monto_pagado: string;
      }>(
        await t.query(
          `SELECT tercero_id, estado, numero_factura_proveedor, monto_pagado
             FROM compra_documento
            WHERE id = $1
            FOR UPDATE`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Compra no encontrada');
      }
      if (documento.estado !== 'EMITIDA') {
        throw new BadRequestException('Esta compra no está vigente.');
      }

      const valorTotal = sumarPagos(dto.pagos.map((p) => p.valor));
      const resultado = calcularDevolucionPago(
        Number(documento.monto_pagado),
        valorTotal,
      );
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

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

      for (const [i, pago] of dto.pagos.entries()) {
        const medio =
          pago.medio === 'CAJA'
            ? ({ medio: 'CAJA', cajaId: pago.cajaId! } as const)
            : ({
                medio: 'BANCO',
                cuentaBancariaId: pago.cuentaBancariaId!,
              } as const);
        const reparto =
          dto.pagos.length === 1 ? '' : ` (${i + 1} de ${dto.pagos.length})`;
        await this.tesoreria.registrarDevolucionPago(
          ctx,
          {
            ...medio,
            fecha: dto.fecha,
            valor: pago.valor,
            concepto: `Devolución de pago de la compra ${documento.numero_factura_proveedor}${reparto}`,
            cuentaProveedoresId: cuentaProveedores.id,
            terceroId: documento.tercero_id,
            compraId: id,
          },
          t,
        );
      }

      const actualizado = fila<CompraDocumentoResumen>(
        await t.query(
          `UPDATE compra_documento SET monto_pagado = $2
            WHERE id = $1
          RETURNING ${CAMPOS_DOCUMENTO}`,
          [id, resultado.montoPagado],
        ),
      );
      if (actualizado === undefined) {
        throw new BadRequestException('No se pudo registrar la devolución.');
      }
      return actualizado;
    });
  }

  /**
   * Resuelve la cuenta `2365{sufijo}` de cada concepto retenido. Rechaza si
   * la empresa no es agente de retención de renta, si la cuenta del
   * concepto no existe, o si lo retenido supera el total de la factura —
   * un dato roto, no un caso a resolver.
   */
  private async resolverRetenciones(
    ctx: CtxEmpresa,
    retenciones: RetencionCompraDto[],
    total: number,
    fecha: string,
    t: Tx,
  ): Promise<
    Array<{ concepto: string; cuentaId: string; base: number; valor: number }>
  > {
    if (retenciones.length === 0) return [];

    const esAgenteRetenedor = await this.regimenIncluye(ctx, fecha, t, [
      'AGENTE_RETENEDOR_RENTA',
      'AUTORRETENEDOR_RENTA',
      'GRAN_CONTRIBUYENTE',
    ]);
    if (!esAgenteRetenedor) {
      throw new BadRequestException(
        'La empresa no es agente de retención en la fuente: no se puede practicar ninguna retención.',
      );
    }

    const sumaRetenida = totalRetenciones(retenciones);
    if (sumaRetenida > total) {
      throw new BadRequestException(
        'Lo retenido no puede superar el total de la factura.',
      );
    }

    const resueltas: Array<{
      concepto: string;
      cuentaId: string;
      base: number;
      valor: number;
    }> = [];
    for (const r of retenciones) {
      const sufijo = SUFIJO_CONCEPTO_RETENCION[r.concepto];
      const codigo = `2365${sufijo}`;
      const cuenta = await this.nucleo.cuenta(ctx, codigo, t);
      if (cuenta === null) {
        throw new BadRequestException(
          `No existe o está inactiva la cuenta de retención por ${r.concepto.toLowerCase()} (${codigo}). Actívala en el plan de cuentas.`,
        );
      }
      resueltas.push({
        concepto: r.concepto,
        cuentaId: cuenta.id,
        base: r.base,
        valor: r.valor,
      });
    }
    return resueltas;
  }

  /** Si alguna de las condiciones vigentes a la fecha está en la lista dada. */
  private async regimenIncluye(
    ctx: CtxEmpresa,
    fecha: string,
    t: Tx,
    condiciones: string[],
  ): Promise<boolean> {
    const vigentes = await this.nucleo.regimenVigente(ctx, fecha, t);
    return vigentes.some((v) => condiciones.includes(v));
  }
}
