import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { hoyEnColombia } from '../../../common/fecha';
import { mensajeNotasVivas, type NotaViva } from '../../../common/notas-vivas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type { CrearCotizacionDto } from '../dto/cotizacion.dto';
import type {
  CobrarDto,
  DevolverCobroDto,
  ListarVentasDto,
} from '../dto/venta.dto';
import {
  calcularCobro,
  calcularDevolucionCobro,
  calcularLineas,
  sumarPagos,
  type LineaVentaEntrada,
} from './venta.reglas';

/** [BASE] en toda empresa (`preactivacion-cuentas-comercio.md`): cartera, exige tercero. */
const CODIGO_CUENTA_CARTERA = '130505';

/** Los cuatro documentos que viven en `venta_documento`. */
export type TipoVentaDocumento =
  'COTIZACION' | 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';

export interface VentaDocumentoResumen {
  id: string;
  tipo: string;
  tercero_id: string;
  tercero_nombre: string;
  /** Ya formateada para mostrar: `NIT 900123456-7`, `CC 19400748`. */
  tercero_identificacion: string;
  fecha: string;
  /** Cuándo vence lo pactado. `null` en las anteriores al 28-09-2026: vencen a los 30 días. */
  vence: string | null;
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
  /**
   * Lo que las notas no anuladas le sumaron o restaron a este documento:
   * negativo por cada nota crédito, positivo por cada nota débito. En una
   * factura, `total + ajuste_notas` es lo que el cliente realmente debe —el
   * `total` a secas dejó de ser esa respuesta cuando aparecieron las notas
   * parciales—. Siempre `0` en una cotización o en una nota.
   */
  ajuste_notas: string;
  /**
   * `total + ajuste_notas`: lo que el documento vale hoy, después de sus
   * notas. Viaja calculado para que ninguna pantalla tenga que rehacer la
   * suma y para que todas la hagan igual.
   */
  saldo_efectivo: string;
  /**
   * Lo que el cliente nos retuvo. No baja el valor de la factura: baja lo que
   * nos van a pagar. Es un anticipo de nuestro impuesto, no un menor ingreso.
   */
  total_retenido: string;
  /**
   * Lo que falta por cobrar: `saldo_efectivo - total_retenido - monto_pagado`,
   * nunca negativo.
   * Cuando se cobró de más, esto es `0` y la diferencia está en
   * `saldo_a_favor` — un pendiente en rojo sería un número que nadie sabe
   * leer y que ninguna pantalla debería sumar a la cartera.
   */
  pendiente: string;
  /**
   * Lo cobrado por encima del saldo efectivo: la plata que hay que
   * devolverle al cliente. Aparece cuando una factura ya cobrada entera
   * recibe después una nota crédito. No es un error de datos —la devolución
   * la hace el paso 13— y por eso se expone aparte y no como pendiente
   * negativo.
   */
  saldo_a_favor: string;
  asiento_id: string | null;
  /**
   * Emitida antes de usar el sistema y cargada con su número original
   * (migración 0065). Sin resolución, sin asiento y sin kardex: se consulta
   * y se cobra, pero no se le hacen notas.
   */
  historica: boolean;
  /**
   * Lo que el motor de retenciones encontró al facturar: el cliente retuvo
   * distinto de la norma, la autorretención que se practicó, falta una tarifa.
   */
  retencion_aviso?: string | null;
}

export interface VentaDocumentoLineaResumen {
  id: string;
  venta_documento_id: string;
  orden: number;
  /** `null` en una línea de servicio u otro ingreso (Fase 8). */
  producto_id: string | null;
  producto_codigo: string | null;
  producto_nombre: string | null;
  /** La línea de concepto: qué concepto, a qué cuenta entró y qué fue. */
  concepto_id?: string | null;
  concepto_nombre?: string | null;
  /** `true` si el concepto es operacional (41, servicio); `false` si es otro ingreso (42). */
  concepto_operacional?: boolean | null;
  cuenta_id?: string | null;
  cuenta_codigo?: string | null;
  cuenta_nombre?: string | null;
  detalle?: string | null;
  cantidad: string;
  precio_unitario: string;
  iva_tarifa: string;
  subtotal: string;
  iva_valor: string;
  total: string;
  costo_unitario: string | null;
}

export interface VentaDocumentoDetalle extends VentaDocumentoResumen {
  /**
   * En una nota: la factura que corrige. En una factura convertida de una
   * cotización: esa cotización. `null` cuando no hay ninguno.
   */
  documento_origen?: VentaDocumentoResumen | null;
  /**
   * En una factura: sus notas crédito y débito, anuladas incluidas —una nota
   * anulada explica por qué el saldo volvió a subir—.
   */
  notas?: VentaDocumentoResumen[];
  lineas: VentaDocumentoLineaResumen[];
}

/**
 * Lo que las notas le movieron al documento. Se deriva y no se guarda: una
 * columna denormalizada habría que mantenerla al día en cada anulación de
 * nota, y el `CHECK ck_venta_monto_pagado (monto_pagado <= total)` seguiría
 * comparando contra el total viejo. Va como subconsulta —y no como JOIN— por
 * lo mismo que el nombre del tercero: así sirve también en los `RETURNING`.
 */
const AJUSTE_NOTAS = `(SELECT coalesce(sum(CASE WHEN n.tipo = 'NOTA_CREDITO' THEN -n.total ELSE n.total END), 0)
                         FROM venta_documento n
                        WHERE n.documento_origen_id = venta_documento.id
                          AND n.tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO')
                          AND n.estado <> 'ANULADA')`;

/**
 * El saldo efectivo y sus dos lados. `greatest(..., 0)` en los dos: la resta
 * que sobra por un lado es exactamente la que falta por el otro, y partirla
 * en dos columnas no negativas evita que una pantalla sume un pendiente en
 * rojo a la cartera y la deje mintiendo.
 *
 * Se paga el costo de repetir la subconsulta de `AJUSTE_NOTAS` tres veces en
 * la misma fila. Es a propósito: la alternativa —un `LATERAL` que la calcule
 * una sola vez— no existe en un `RETURNING`, y estas columnas tienen que
 * viajar también con el documento recién insertado.
 */
const SALDO_EFECTIVO = `(total + ${AJUSTE_NOTAS})`;

/**
 * Lo que el cliente nos retuvo. **No baja lo que la factura vale** —el saldo
 * efectivo no lo mira— sino lo que nos van a pagar: es impuesto nuestro que el
 * cliente le entrega a la DIAN en nuestro nombre, y cobrárselo además sería
 * cobrarlo dos veces.
 */
const RETENIDO = `(SELECT coalesce(sum(r.valor), 0)
                     FROM venta_retencion r
                    WHERE r.venta_documento_id = venta_documento.id)`;

const POR_COBRAR = `(${SALDO_EFECTIVO} - ${RETENIDO})`;
const PENDIENTE = `greatest(${POR_COBRAR} - monto_pagado, 0)`;
const SALDO_A_FAVOR = `greatest(monto_pagado - ${POR_COBRAR}, 0)`;

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
//
// Se exporta porque `FacturaService`, `NotaCreditoService` y
// `NotaDebitoService` devuelven el mismo `VentaDocumentoResumen` desde sus
// `RETURNING`: cada uno tenía su propia copia de esta lista, y las copias se
// quedaron atrás —el `POST /facturas` respondía sin el nombre ni el NIT del
// cliente, y habría respondido sin el saldo—. Una sola lista, un solo lugar
// donde agregarle una columna.
export const CAMPOS_DOCUMENTO = `id, tipo, tercero_id, fecha, vence, estado, prefijo, consecutivo,
                           resolucion_id, documento_origen_id, subtotal, total_iva, total,
                           monto_pagado, asiento_id, historica, retencion_aviso,
                           (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.segundo_nombre, x.primer_apellido, x.segundo_apellido))
                              FROM tercero x WHERE x.id = tercero_id) AS tercero_nombre,
                           ${IDENTIFICACION_TERCERO} AS tercero_identificacion,
                           ${AJUSTE_NOTAS} AS ajuste_notas,
                           ${SALDO_EFECTIVO} AS saldo_efectivo,
                           ${RETENIDO} AS total_retenido,
                           ${PENDIENTE} AS pendiente,
                           ${SALDO_A_FAVOR} AS saldo_a_favor`;

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre,
                       concepto_id, cuenta_id, detalle,
                       (SELECT x.nombre FROM concepto_movimiento x WHERE x.id = concepto_id) AS concepto_nombre,
                       (SELECT x.codigo LIKE '41%' FROM empresa_cuenta x WHERE x.id = cuenta_id AND concepto_id IS NOT NULL) AS concepto_operacional,
                       (SELECT x.codigo FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_codigo,
                       (SELECT x.nombre FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_nombre`;

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
    private readonly retenciones: RetencionesApi,
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
    tipo: TipoVentaDocumento,
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
    tipo: TipoVentaDocumento,
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

        // Las dos direcciones del enlace: desde la nota, su factura; desde la
        // factura, sus notas. Sin esto, quien mira una nota crédito ve un
        // UUID donde tendría que ver "factura SETP-991".
        const documentoOrigen =
          documento.documento_origen_id === null
            ? null
            : (fila<VentaDocumentoResumen>(
                await t.query(
                  `SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento WHERE id = $1`,
                  [documento.documento_origen_id],
                ),
              ) ?? null);

        const notas = filas<VentaDocumentoResumen>(
          await t.query(
            `SELECT ${CAMPOS_DOCUMENTO} FROM venta_documento
              WHERE documento_origen_id = $1
                AND tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO')
              ORDER BY fecha, consecutivo`,
            [id],
          ),
        );

        return {
          ...documento,
          lineas,
          documento_origen: documentoOrigen,
          notas,
        };
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
        numero: string;
        historica: boolean;
      }>(
        await t.query(
          `SELECT tipo, estado, asiento_id, monto_pagado, historica,
                  concat_ws('-', nullif(prefijo, ''), consecutivo::text) AS numero
             FROM venta_documento WHERE id = $1
             FOR UPDATE`,
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
      // Con notas vivas no se anula: primero las notas (`notas-vivas.ts`). El
      // `FOR UPDATE` de arriba es el candado contra una nota que se emita
      // mientras tanto: la nota bloquea la factura antes de mirarla
      // (`NotaCreditoService.crear`, `NotaDebitoService.crear`). Una nota no
      // tiene notas propias: para ella esto no encuentra nada.
      const notasVivas = filas<NotaViva>(
        await t.query(
          `SELECT tipo,
                  concat_ws('-', nullif(prefijo, ''), consecutivo::text) AS numero
             FROM venta_documento
            WHERE documento_origen_id = $1
              AND tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO')
              AND estado <> 'ANULADA'
            ORDER BY fecha, consecutivo`,
          [id],
        ),
      );
      if (notasVivas.length > 0) {
        throw new ConflictException(mensajeNotasVivas('factura', notasVivas));
      }
      // La plata ya entró: anular el documento dejaría un cobro colgado de
      // nada y la cartera del cliente en negativo. Lo que corrige una
      // factura cobrada es una nota crédito, que deja el saldo a favor
      // registrado; el cobro no se toca porque ocurrió de verdad.
      //
      // En una histórica, `monto_pagado` trae además lo que se pagó en el
      // sistema anterior, que no es un cobro de acá: no hay plata que quede
      // colgando. Lo que la traba es un cobro registrado **en este sistema**,
      // y eso lo dicen los movimientos de caja y bancos, no la columna.
      const cobrada = documento.historica
        ? await this.tieneCobrosEnElSistema(id, t)
        : Number(documento.monto_pagado) > 0;
      if (cobrada) {
        throw new BadRequestException(
          documento.historica
            ? 'Esta factura tiene cobros registrados en el sistema y no se puede anular. Devolvé esos cobros primero.'
            : 'Esta factura tiene cobros registrados y no se puede anular. Para corregirla, emití una nota crédito.',
        );
      }

      // Una histórica no tiene asiento ni kardex que deshacer: se anula porque
      // se cargó mal, y anularla libera su número para cargarla bien
      // (`ux_venta_numero`, migración 0065).
      if (documento.historica) {
        await t.query(
          `UPDATE venta_documento
              SET estado = 'ANULADA', motivo_anulacion = $2,
                  anulado_en = now(), anulado_por = $3
            WHERE id = $1`,
          [id, motivo, ctx.usuarioId],
        );
        return;
      }

      // `asiento_id` no puede ser NULL acá: `ck_venta_fiscal` lo exige para
      // todo lo que no sea cotización ni histórica, y las dos ya se
      // descartaron arriba.
      await this.contabilidad.anular(
        ctx,
        documento.asiento_id as string,
        motivo,
        t,
      );

      // La mercancía que la factura sacó vuelve al kardex, al costo con que
      // salió. Antes se anulaba solo el asiento: el libro dejaba de contar la
      // venta y el kardex seguía con las unidades descontadas —la SETT-13 dejó
      // así 7 unidades y $ 208.050—. Una nota crédito no movió kardex, así que
      // para ella esto no hace nada.
      await this.inventario.revertirPorAnulacion(
        ctx,
        documento.asiento_id as string,
        hoyEnColombia(),
        `Anulación de ${documento.tipo === 'FACTURA' ? 'la factura' : 'el documento'} ${documento.numero}: ${motivo}`,
        t,
      );

      // La autorretención también se anula —la de la factura, o la que una nota
      // había devuelto—: el asiento ya la reversó, pero el 350 la lee de
      // `retencion_calculada`.
      await this.retenciones.anularAutorretencion(
        ctx,
        { documentoId: id, fecha: hoyEnColombia(), motivo },
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
   * Si lo cobrado de una factura **en este sistema** —por caja o por banco,
   * descontando las devoluciones— es más que cero. Lo usa la anulación de una
   * histórica, cuyo `monto_pagado` mezcla lo pagado antes con lo cobrado acá.
   */
  private async tieneCobrosEnElSistema(id: string, t: Tx): Promise<boolean> {
    const r = fila<{ neto: string }>(
      await t.query(
        `SELECT coalesce(sum(neto), 0) AS neto FROM (
           SELECT CASE WHEN tipo = 'INGRESO' THEN valor ELSE -valor END AS neto
             FROM caja_movimiento
            WHERE origen_tipo = 'FACTURA_VENTA' AND origen_id = $1
           UNION ALL
           SELECT CASE WHEN tipo IN ('CONSIGNACION', 'TRANSFERENCIA_ENTRANTE', 'NOTA_CREDITO')
                       THEN valor ELSE -valor END
             FROM banco_movimiento
            WHERE origen_tipo = 'FACTURA_VENTA' AND origen_id = $1
         ) m`,
        [id],
      ),
    );
    return Number(r?.neto ?? 0) > 0.005;
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
    return this.tx.enContexto(ctx, (t) => this.cobrarEnTx(ctx, id, dto, t));
  }

  /**
   * El cuerpo de `cobrar`, sobre una transacción ya abierta. Lo usa también
   * `FacturaService` para la factura de contado: emitirla y cobrarla es un
   * solo acto, y si el cobro falla —una caja cerrada, una cuenta inactiva—
   * la factura tampoco queda.
   */
  async cobrarEnTx(
    ctx: CtxEmpresa,
    id: string,
    dto: CobrarDto,
    t: Tx,
    /** El documento que agrupa este cobro —«RC-000128»—, para el libro de caja. */
    referencia?: string,
  ): Promise<VentaDocumentoResumen> {
    const documento = fila<{
      tipo: string;
      tercero_id: string;
      estado: string;
      prefijo: string | null;
      consecutivo: number;
      total: string;
      monto_pagado: string;
      por_cobrar: string;
    }>(
      await t.query(
        `SELECT tipo, tercero_id, estado, prefijo, consecutivo, total, monto_pagado,
                ${POR_COBRAR} AS por_cobrar
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

    // La suma de los renglones se valida UNA vez contra el saldo: repartir
    // un cobro entre caja y banco no cambia cuánto se debe, solo de dónde
    // entra. Validar renglón por renglón dejaría pasar dos que por separado
    // caben y juntos se pasan.
    const valorTotal = sumarPagos(dto.pagos.map((p) => p.valor));

    // Contra lo que queda por cobrar: el total, menos lo que las notas le
    // movieron, menos lo que el cliente nos retuvo. Cobrarle el total a una
    // factura con retención sería cobrar dos veces el mismo impuesto.
    const resultado = calcularCobro(
      Number(documento.por_cobrar),
      Number(documento.monto_pagado),
      valorTotal,
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

    // Un movimiento por renglón, todos en la MISMA transacción que ya está
    // abierta —`TesoreriaApi` acepta la `tx` externa desde el paso 12.1 de
    // `caja-cartera.md`—: la plata que entra por caja y la que entra por
    // banco se confirman juntas o no entra ninguna.
    //
    // El `concepto` numera el renglón solo cuando hay más de uno: con un
    // solo pago el movimiento sale idéntico a como salía antes, y con
    // varios el libro de caja no muestra dos líneas indistinguibles.
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
      await this.tesoreria.registrarCobro(
        ctx,
        {
          ...medio,
          fecha: dto.fecha,
          valor: pago.valor,
          concepto: `${referencia === undefined ? '' : `${referencia} · `}Cobro de la factura ${numero}${reparto}`,
          cuentaClientesId: cuentaCartera.id,
          terceroId: documento.tercero_id,
          facturaVentaId: id,
        },
        t,
      );
    }

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
  }

  /**
   * Devuelve parte —o todo— de lo que ya se cobró de una factura.
   *
   * **No es una nota crédito.** La nota crédito baja lo que la factura vale;
   * esto la deja valiendo igual y le devuelve plata al cliente. Las dos
   * existen porque son cosas distintas: un producto que vuelve cambia el
   * documento, y un cobro de más solo cambia la caja.
   *
   * Es también la salida del caso borde que dejó el paso 11: una factura
   * cobrada entera que después recibe una nota crédito queda con
   * `saldo_a_favor`, y esto es lo que lo salda.
   *
   * Mismo reparto que `cobrar` —puede salir de caja, de banco o de las dos—,
   * mismo candado `FOR UPDATE`, misma transacción para los movimientos y el
   * `UPDATE`. **El egreso de caja puede fallar por saldo** y lo dice
   * `calcularEgreso` con su propio mensaje: un cajón no queda en rojo. Banco
   * sí admite sobregiro.
   */
  async devolverCobro(
    ctx: CtxEmpresa,
    id: string,
    dto: DevolverCobroDto,
  ): Promise<VentaDocumentoResumen> {
    return this.tx.enContexto(ctx, (t) =>
      this.devolverCobroEnTx(ctx, id, dto, t),
    );
  }

  /**
   * El cuerpo de `devolverCobro`, sobre una transacción ya abierta. Lo usa
   * también la anulación de un recibo de caja: devolver cada cobro que el
   * recibo hizo y marcarlo anulado son un solo acto.
   */
  async devolverCobroEnTx(
    ctx: CtxEmpresa,
    id: string,
    dto: DevolverCobroDto,
    t: Tx,
    /** El documento que se anula —«RC-000128»—, para el libro de caja. */
    referencia?: string,
  ): Promise<VentaDocumentoResumen> {
    const documento = fila<{
      tipo: string;
      tercero_id: string;
      estado: string;
      prefijo: string | null;
      consecutivo: number;
      monto_pagado: string;
    }>(
      await t.query(
        `SELECT tipo, tercero_id, estado, prefijo, consecutivo, monto_pagado
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
      throw new BadRequestException(
        'Solo se puede devolver el cobro de una factura.',
      );
    }
    if (documento.estado !== 'EMITIDA') {
      throw new BadRequestException('Esta factura no está vigente.');
    }

    // Contra lo cobrado, no contra el saldo: lo que se devuelve es plata
    // que entró, y cuánto vale hoy la factura no cambia esa cuenta.
    const valorTotal = sumarPagos(dto.pagos.map((p) => p.valor));
    // Lo que se saldó con un descuento por pronto pago no entró como plata:
    // no se puede devolver en efectivo. Se descuenta de lo cobrado para medir
    // y se vuelve a sumar al guardar.
    const descontado = Number(
      fila<{ total: string }>(
        await t.query(
          `SELECT coalesce(sum(a.descuento), 0) AS total
             FROM recibo_caja_aplicacion a
             JOIN recibo_caja r ON r.id = a.recibo_id AND r.estado = 'VIGENTE'
            WHERE a.venta_documento_id = $1`,
          [id],
        ),
      )?.total ?? 0,
    );
    const medido = calcularDevolucionCobro(
      Number(documento.monto_pagado) - descontado,
      valorTotal,
    );
    if (!medido.ok) {
      throw new BadRequestException(medido.motivo);
    }
    const resultado = { montoPagado: medido.montoPagado + descontado };

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
      await this.tesoreria.registrarDevolucionCobro(
        ctx,
        {
          ...medio,
          fecha: dto.fecha,
          valor: pago.valor,
          concepto: `${referencia === undefined ? '' : `${referencia} · `}Devolución de cobro de la factura ${numero}${reparto}`,
          cuentaClientesId: cuentaCartera.id,
          terceroId: documento.tercero_id,
          facturaVentaId: id,
        },
        t,
      );
    }

    const actualizado = fila<VentaDocumentoResumen>(
      await t.query(
        `UPDATE venta_documento SET monto_pagado = $2
            WHERE id = $1
          RETURNING ${CAMPOS_DOCUMENTO}`,
        [id, resultado.montoPagado],
      ),
    );
    if (actualizado === undefined) {
      throw new BadRequestException('No se pudo registrar la devolución.');
    }
    return actualizado;
  }

  /**
   * Mueve lo pagado de una factura sin que entre ni salga plata: un
   * descuento por pronto pago la salda, un anticipo del cliente se le
   * aplica, un saldo a favor pasa de una factura a otra. Quien llama asienta
   * lo que corresponda; esto solo mantiene `monto_pagado` en su verdad.
   *
   * Positivo baja lo que se debe y no puede pasar del pendiente. Negativo lo
   * sube de vuelta y no puede dejar lo pagado bajo cero. `restituir` deja
   * que un positivo pase del pendiente: es devolverle a una factura el saldo
   * a favor que ya tenía, al anular el cruce que se lo llevó.
   */
  async ajustarPagadoEnTx(
    ctx: CtxEmpresa,
    id: string,
    delta: number,
    t: Tx,
    opciones: { restituir?: boolean } = {},
  ): Promise<VentaDocumentoResumen> {
    const documento = fila<{
      tipo: string;
      estado: string;
      monto_pagado: string;
      por_cobrar: string;
      prefijo: string | null;
      consecutivo: number;
    }>(
      await t.query(
        `SELECT tipo, estado, monto_pagado, ${POR_COBRAR} AS por_cobrar, prefijo, consecutivo
           FROM venta_documento WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (documento === undefined)
      throw new NotFoundException('Documento no encontrado');
    if (documento.tipo !== 'FACTURA' || documento.estado !== 'EMITIDA') {
      throw new BadRequestException(
        'Solo se ajusta lo pagado de una factura vigente.',
      );
    }
    const numero = `${documento.prefijo}-${String(documento.consecutivo).padStart(6, '0')}`;
    const pagado = Math.round(Number(documento.monto_pagado) * 100);
    const cambio = Math.round(delta * 100);
    const pendiente = Math.round(Number(documento.por_cobrar) * 100) - pagado;
    if (cambio > 0 && !opciones.restituir && cambio > pendiente) {
      throw new BadRequestException(
        `A ${numero} solo le faltan ${Math.max(pendiente, 0) / 100}: no se le puede aplicar ${delta}.`,
      );
    }
    if (cambio < 0 && -cambio > pagado) {
      throw new BadRequestException(
        `De ${numero} no hay tanto pagado para devolver.`,
      );
    }
    const actualizado = fila<VentaDocumentoResumen>(
      await t.query(
        `UPDATE venta_documento SET monto_pagado = $2 WHERE id = $1 RETURNING ${CAMPOS_DOCUMENTO}`,
        [id, (pagado + cambio) / 100],
      ),
    );
    if (actualizado === undefined)
      throw new BadRequestException('No se pudo ajustar la factura.');
    return actualizado;
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
