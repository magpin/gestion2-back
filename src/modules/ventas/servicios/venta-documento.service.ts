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
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type { CrearCotizacionDto } from '../dto/cotizacion.dto';
import type { CobrarDto, ListarVentasDto } from '../dto/venta.dto';
import {
  calcularCobro,
  calcularLineas,
  type LineaVentaEntrada,
} from './venta.reglas';

/** [BASE] en toda empresa (`preactivacion-cuentas-comercio.md`): cartera, exige tercero. */
const CODIGO_CUENTA_CARTERA = '130505';

export interface VentaDocumentoResumen {
  id: string;
  tipo: string;
  tercero_id: string;
  tercero_nombre: string;
  /** Ya formateada para mostrar: `NIT 900123456-7`, `CC 19400748`. */
  tercero_identificacion: string;
  fecha: string;
  estado: string;
  prefijo: string | null;
  consecutivo: number;
  resolucion_id: string | null;
  documento_origen_id: string | null;
  subtotal: string;
  total_iva: string;
  total: string;
  /** Cuánto se ha cobrado. Siempre `0` en COTIZACION/NOTA_CREDITO — nadie cobra esas. */
  monto_pagado: string;
  asiento_id: string | null;
}

export interface VentaDocumentoLineaResumen {
  id: string;
  venta_documento_id: string;
  orden: number;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
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

/**
 * El documento y su número, armados en la consulta.
 *
 * Con 4.282 terceros hay homónimos y nombres partidos por heurística al
 * importar: el nombre solo no identifica a nadie, y quien factura reconoce al
 * cliente por el NIT. Se arma acá y no en el frontend por el mismo motivo que
 * el nombre —una sola vuelta a `tercero`— y porque el guion del DV es parte
 * del número, no una decisión de cada pantalla.
 */
const IDENTIFICACION_TERCERO = `(SELECT concat_ws(' ', x.tipo_documento,
                                        x.numero_documento || coalesce('-' || x.dv, ''))
                                   FROM tercero x WHERE x.id = tercero_id)`;

// El nombre del tercero y del producto viajan con el documento: una lista de
// facturas que muestre ids obliga al frontend a traerse el maestro entero —con
// miles de terceros, no cabe en una página—. Subconsultas y no JOIN, para que
// las mismas columnas sirvan en los RETURNING de los INSERT/UPDATE.
const CAMPOS_DOCUMENTO = `id, tipo, tercero_id, fecha, estado, prefijo, consecutivo,
                           resolucion_id, documento_origen_id, subtotal, total_iva, total,
                           monto_pagado, asiento_id,
                           (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.segundo_nombre, x.primer_apellido, x.segundo_apellido))
                              FROM tercero x WHERE x.id = tercero_id) AS tercero_nombre,
                           ${IDENTIFICACION_TERCERO} AS tercero_identificacion`;

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre`;

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
 *
 * `anular` y `cobrar` viven acá y no en `FacturaService` porque son
 * operaciones sobre el documento ya existente, no sobre su creación —
 * mismo criterio que separa `KardexService` de `ProductoService`.
 */
@Injectable()
export class VentaDocumentoService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly tesoreria: TesoreriaApi,
  ) {}

  /**
   * El cliente y las líneas de una cotización: lo que `crearCotizacion` y
   * `editarCotizacion` hacen igual. Devuelve las líneas ya calculadas —con su
   * precio e IVA resueltos— y los totales del documento.
   */
  private async armarCotizacion(
    ctx: CtxEmpresa,
    dto: CrearCotizacionDto,
    t: Tx,
  ): Promise<ReturnType<typeof calcularLineas>> {
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

      // El precio de lista manda cuando existe; el digitado en la línea es
      // la salida para un producto que todavía no tiene precio —los 1.638
      // importados llegaron así—. Una cotización no es un dato fiscal: que
      // quede trabada por un dato que falta en la ficha no le sirve a nadie.
      const precioVigente = await this.inventario.precioVigente(
        ctx,
        l.productoId,
        t,
      );
      const precio =
        precioVigente !== null && precioVigente > 0
          ? precioVigente
          : l.precioUnitario;
      if (precio === undefined) {
        throw new BadRequestException(
          `El producto ${producto.codigo} no tiene precio de venta configurado: fijale uno en su ficha, o digitá el precio en la línea.`,
        );
      }

      entradas.push({
        cantidad: l.cantidad,
        precioUnitario: precio,
        ivaTarifa: responsableIva ? Number(producto.iva_tarifa) : 0,
      });
    }

    return calcularLineas(entradas);
  }

  async crearCotizacion(
    ctx: CtxEmpresa,
    dto: CrearCotizacionDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const { lineas, totales } = await this.armarCotizacion(ctx, dto, t);

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
   * Corrige una cotización vigente: cliente, fecha y líneas.
   *
   * Una cotización es una oferta y una oferta se negocia — el cliente pide
   * cambiar una cantidad y hasta ahora había que hacer otra, con otro número,
   * dejando la primera viva para siempre. No es un documento fiscal: no numeró
   * contra la resolución DIAN, no asentó y no movió kardex, así que corregirla
   * no deja nada inconsistente detrás.
   *
   * El consecutivo NO se reasigna: sigue siendo la misma cotización, con el
   * número que el cliente ya tiene en la mano.
   *
   * Las líneas se reemplazan, no se editan: el `UPDATE` sobre
   * `venta_documento_linea` está prohibido por trigger (`0038`), y el `DELETE`
   * solo se permite en una COTIZACION EMITIDA. El `FOR UPDATE` de la cabecera
   * es el candado: si una conversión a factura llega a la vez, una de las dos
   * espera, y la que pierde ve el estado ya cambiado y se rechaza.
   */
  async editarCotizacion(
    ctx: CtxEmpresa,
    id: string,
    dto: CrearCotizacionDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCotizacionVigente(id, t, 'corregir');

      const { lineas, totales } = await this.armarCotizacion(ctx, dto, t);

      const documento = fila<VentaDocumentoResumen>(
        await t.query(
          `UPDATE venta_documento
              SET tercero_id = $2, fecha = $3, subtotal = $4, total_iva = $5, total = $6
            WHERE id = $1
            RETURNING ${CAMPOS_DOCUMENTO}`,
          [
            id,
            dto.terceroId,
            dto.fecha,
            totales.subtotal,
            totales.totalIva,
            totales.total,
          ],
        ),
      );
      if (documento === undefined) {
        throw new BadRequestException('No se pudo corregir la cotización.');
      }

      await t.query(
        `DELETE FROM venta_documento_linea WHERE venta_documento_id = $1`,
        [id],
      );

      const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        const insertada = fila<VentaDocumentoLineaResumen>(
          await t.query(
            `INSERT INTO venta_documento_linea
               (empresa_id, venta_documento_id, orden, producto_id, cantidad,
                precio_unitario, iva_tarifa, subtotal, iva_valor, total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING ${CAMPOS_LINEA}`,
            [
              ctx.empresaId,
              id,
              i + 1,
              dto.lineas[i].productoId,
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
   * Descarta una cotización: el cliente no la tomó, o se rehízo de cero.
   *
   * Nada se borra en este sistema, así que descartar es anular con motivo —el
   * número gastado queda con su explicación—. Es un método aparte de `anular`
   * a propósito: `anular` existe para documentos fiscales y lo primero que
   * hace es anular su asiento, y una cotización no tiene ninguno.
   */
  async descartarCotizacion(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await this.exigirCotizacionVigente(id, t, 'descartar');
      await t.query(
        `UPDATE venta_documento
            SET estado = 'ANULADA', motivo_anulacion = $2,
                anulado_en = now(), anulado_por = $3
          WHERE id = $1`,
        [id, motivo, ctx.usuarioId],
      );
    });
  }

  /**
   * Bloquea la cotización y exige que todavía se pueda tocar. `FOR UPDATE`
   * porque el estado es justo lo que otra operación simultánea podría estar
   * cambiando —una conversión a factura—.
   */
  private async exigirCotizacionVigente(
    id: string,
    t: Tx,
    accion: 'corregir' | 'descartar',
  ): Promise<void> {
    const documento = fila<{ tipo: string; estado: string }>(
      await t.query(
        `SELECT tipo, estado FROM venta_documento WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (documento === undefined) {
      throw new NotFoundException('Cotización no encontrada.');
    }
    if (documento.tipo !== 'COTIZACION') {
      throw new BadRequestException(
        `Esto no es una cotización. Una factura o una nota crédito no se ${accion}n.`,
      );
    }
    if (documento.estado === 'CONVERTIDA') {
      throw new BadRequestException(
        `Esta cotización ya se convirtió en factura y no se puede ${accion}. Lo que corrige una factura es una nota crédito.`,
      );
    }
    if (documento.estado !== 'EMITIDA') {
      throw new BadRequestException(
        `Esta cotización ya está descartada y no se puede ${accion}.`,
      );
    }
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
        monto_pagado: string;
      }>(
        await t.query(
          `SELECT tipo, estado, asiento_id, monto_pagado FROM venta_documento WHERE id = $1`,
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
      // La plata ya entró: anular el documento dejaría un cobro colgado de
      // nada y la cartera del cliente en negativo. Lo que corrige una
      // factura cobrada es una nota crédito, que deja el saldo a favor
      // registrado; el cobro no se toca porque ocurrió de verdad.
      if (Number(documento.monto_pagado) > 0) {
        throw new BadRequestException(
          'Esta factura tiene cobros registrados y no se puede anular. Para corregirla, emití una nota crédito.',
        );
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

  /**
   * Cobra una factura en efectivo, total o parcialmente. El cobro
   * (`TesoreriaApi.registrarCobro`) y la actualización de `monto_pagado`
   * se confirman en la MISMA transacción — no puede quedar la plata en la
   * caja sin que la factura se entere, ni al revés.
   *
   * El `FOR UPDATE` sobre la factura es el candado: dos cobros
   * simultáneos de la misma factura no pueden leer el mismo
   * `monto_pagado` y pisarse, mismo motivo que
   * `CajaMovimientoService.exigirCajaBloqueada`.
   */
  async cobrar(
    ctx: CtxEmpresa,
    id: string,
    dto: CobrarDto,
  ): Promise<VentaDocumentoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const documento = fila<{
        tipo: string;
        tercero_id: string;
        estado: string;
        prefijo: string | null;
        consecutivo: number;
        total: string;
        monto_pagado: string;
      }>(
        await t.query(
          `SELECT tipo, tercero_id, estado, prefijo, consecutivo, total, monto_pagado
             FROM venta_documento
            WHERE id = $1
            FOR UPDATE`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Documento no encontrado');
      }
      if (documento.tipo !== 'FACTURA') {
        throw new BadRequestException('Solo se puede cobrar una factura.');
      }
      if (documento.estado !== 'EMITIDA') {
        throw new BadRequestException('Esta factura no está vigente.');
      }

      const resultado = calcularCobro(
        Number(documento.total),
        Number(documento.monto_pagado),
        dto.valor,
      );
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
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

      const numero = `${documento.prefijo}-${String(documento.consecutivo).padStart(6, '0')}`;
      const medio =
        dto.medio === 'CAJA'
          ? ({ medio: 'CAJA', cajaId: dto.cajaId! } as const)
          : ({
              medio: 'BANCO',
              cuentaBancariaId: dto.cuentaBancariaId!,
            } as const);
      await this.tesoreria.registrarCobro(
        ctx,
        {
          ...medio,
          fecha: dto.fecha,
          valor: dto.valor,
          concepto: `Cobro de la factura ${numero}`,
          cuentaClientesId: cuentaCartera.id,
          terceroId: documento.tercero_id,
          facturaVentaId: id,
        },
        t,
      );

      const actualizado = fila<VentaDocumentoResumen>(
        await t.query(
          `UPDATE venta_documento SET monto_pagado = $2
            WHERE id = $1
          RETURNING ${CAMPOS_DOCUMENTO}`,
          [id, resultado.montoPagado],
        ),
      );
      if (actualizado === undefined) {
        throw new BadRequestException('No se pudo registrar el cobro.');
      }
      return actualizado;
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
