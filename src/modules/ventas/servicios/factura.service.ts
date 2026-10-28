import { randomUUID } from 'node:crypto';

import { numeracionDe, type Numeracion } from '../../../common/numeracion';
import { diasDePlazo, venceDesdePlazo } from '../../../common/plazo';
import { cuentaDeIngreso } from './concepto-ingreso';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { esDeHoy, hoyEnColombia } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import type { ConvertirCotizacionDto } from '../dto/cotizacion.dto';
import type { CrearFacturaDto, RetencionVentaDto } from '../dto/factura.dto';
import {
  CAMPOS_DOCUMENTO,
  VentaDocumentoService,
  type VentaDocumentoDetalle,
  type VentaDocumentoLineaResumen,
  type VentaDocumentoResumen,
} from './venta-documento.service';
import { CruceCarteraService } from './cruce-cartera.service';
import {
  calcularLineas,
  evaluarMargen,
  resolverPrecio,
  validarFormaPago,
  type LineaVentaEntrada,
} from './venta.reglas';
import { cuentaInactiva } from '../../../common/contabilidad/cuenta-inactiva';
import { glosaContado } from '../../../common/contabilidad/glosa-contado';

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario,
                       concepto_id, cuenta_id, detalle`;

/** [BASE] en toda empresa (`preactivacion-cuentas-comercio.md`): cartera, exige tercero. */
const CODIGO_CUENTA_CARTERA = '130505';
/** [COND si responsable de IVA] — solo se busca cuando el documento liquida IVA. */
const CODIGO_CUENTA_IVA_GENERADO = '240805';
/** Comprobante de ingreso, uno de los cinco que siembra toda empresa nueva. */
const CODIGO_COMPROBANTE_VENTA = 'CI';

/** De qué pedido leído salió una factura, cuando no la armó una persona desde cero. */
export interface OrigenDeLaFactura {
  documentoLeidoId: string;
}

/**
 * Crea la factura de venta: el único servicio de `ventas` que asienta y
 * mueve el kardex. Todo en una sola transacción, en este orden exacto:
 *
 *   1. Período abierto (antes de gastar un consecutivo que no se puede
 *      devolver).
 *   2. `InventarioApi.costearSalida` por línea — calcula el costo, no
 *      inserta nada todavía.
 *   3. Arma y guarda el asiento completo (ingreso, IVA, cartera, costo,
 *      inventario) con `ContabilidadApi.asentar`.
 *   4. Inserta la factura y sus líneas, con el `asiento_id` ya resuelto.
 *   5. `InventarioApi.descontarPorVenta` por línea — recién ahora escribe
 *      el kardex, con el mismo `asiento_id`.
 *
 * Si cualquier paso falla, todo se revierte: no puede quedar un asiento sin
 * factura, una factura sin kardex descontado, ni un consecutivo quemado sin
 * documento.
 *
 * `crear()` (factura directa) y `convertirCotizacion()` (factura desde una
 * cotización) comparten ese cuerpo entero en `crearInterno` — lo único que
 * cambia entre las dos es de dónde salen `terceroId`/`lineas` y si queda
 * `documento_origen_id` enlazado.
 */
@Injectable()
export class FacturaService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly ventas: VentaDocumentoService,
    private readonly retenciones: RetencionesApi,
    /** Anticipos y saldos a favor que se aplican al emitir (`dto.aplicar`). */
    private readonly cruces?: CruceCarteraService,
  ) {}

  /**
   * `origen` lo pone el servidor, nunca el navegador: dice de qué pedido leído
   * salió la factura, y si viniera en el cuerpo cualquiera podría decir que una
   * factura digitada salió de un documento que María leyó. Mismo criterio que
   * `OrigenDeLaCompra`.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: CrearFacturaDto,
    origen?: OrigenDeLaFactura,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, (t) =>
      this.crearInterno(ctx, dto, null, t, origen),
    );
  }

  /** El número que sale si se emite ahora, de la resolución de facturación. */
  async numeracion(ctx: CtxEmpresa, tx?: Tx): Promise<Numeracion | null> {
    return this.tx.enContexto(ctx, (t) => numeracionDe(t, 'FACTURA_VENTA'), tx);
  }

  /**
   * Cómo quedaría la factura, sin emitirla (pantalla 13): corre `crear` de
   * verdad dentro de un savepoint y lo deshace. No hay una segunda cuenta que
   * se pueda desalinear de la que se guarda; el consecutivo, el kardex y el
   * cobro de contado también se deshacen.
   */
  async previo(
    ctx: CtxEmpresa,
    dto: CrearFacturaDto,
    tx?: Tx,
  ): Promise<{
    numero: string;
    subtotal: number;
    iva: number;
    total: number;
    /** Lo que el cliente nos retiene, una por una. */
    retenciones: Array<{
      tipo: string;
      nombre: string;
      tarifa: number;
      base: number;
      valor: number;
    }>;
    retenido: number;
    /** Lo que va a entrar: el total menos lo retenido. */
    neto: number;
    vence: string | null;
    asiento: Array<{
      codigo: string;
      nombre: string;
      debito: number;
      credito: number;
    }>;
    /** El par costo de venta contra inventario, aparte: no es lo que se cobra. */
    costo: number;
    /** De contado: por dónde entra la plata y cuánto por cada medio. */
    pagos: Array<{ medio: 'CAJA' | 'BANCO'; nombre: string; valor: number }>;
  }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        await t.query('SAVEPOINT factura_previa');
        try {
          const salida: Parameters<FacturaService['crearInterno']>[5] = {
            pagos: [],
          };
          const factura = await this.crearInterno(
            ctx,
            dto,
            null,
            t,
            undefined,
            salida,
          );
          // Por dónde entra la plata de contado, con el nombre de cada caja o
          // cuenta y el valor que le tocó (el renglón en blanco, el resto).
          const pagos: Array<{
            medio: 'CAJA' | 'BANCO';
            nombre: string;
            valor: number;
          }> = [];
          for (const p of salida.pagos) {
            const [medio] = filas<{ nombre: string }>(
              p.medio === 'CAJA'
                ? await t.query(`SELECT nombre FROM caja WHERE id = $1`, [
                    p.cajaId,
                  ])
                : await t.query(
                    `SELECT banco || ' ···' || right(numero_cuenta, 4) AS nombre
                       FROM cuenta_bancaria WHERE id = $1`,
                    [p.cuentaBancariaId],
                  ),
            );
            pagos.push({
              medio: p.medio === 'CAJA' ? 'CAJA' : 'BANCO',
              nombre: medio?.nombre ?? '',
              valor: p.valor,
            });
          }
          const [doc] = filas<{ asiento_id: string; vence: string | null }>(
            await t.query(
              `SELECT asiento_id, vence::text AS vence FROM venta_documento WHERE id = $1`,
              [factura.id],
            ),
          );
          const lineas = filas<{
            codigo: string;
            nombre: string;
            centro: string | null;
            debito: string;
            credito: string;
          }>(
            await t.query(
              `SELECT c.codigo, c.nombre, l.debito, l.credito,
                        cc.codigo || ' · ' || cc.nombre AS centro
                 FROM asiento_linea l JOIN empresa_cuenta c ON c.id = l.cuenta_id
                 LEFT JOIN empresa_centro_costo cc ON cc.id = l.centro_costo_id
                WHERE l.asiento_id = $1 ORDER BY l.orden`,
              [doc.asiento_id],
            ),
          );
          const retenciones = filas<{
            tipo: string;
            nombre: string;
            tarifa: string;
            base: string;
            valor: string;
          }>(
            await t.query(
              `SELECT r.tipo, c.nombre, r.tarifa, r.base, r.valor
                 FROM venta_retencion r JOIN empresa_cuenta c ON c.id = r.cuenta_id
                WHERE r.venta_documento_id = $1 ORDER BY r.valor DESC`,
              [factura.id],
            ),
          );
          const [costo] = filas<{ costo: string | null }>(
            await t.query(
              `SELECT sum(round(cantidad * costo_unitario, 2)) AS costo
                 FROM venta_documento_linea WHERE venta_documento_id = $1`,
              [factura.id],
            ),
          );
          // El costo se muestra aparte: 6 (costo de venta) y 14 (inventario).
          const esCosto = (codigo: string) =>
            codigo.startsWith('6') || codigo.startsWith('14');
          const retenido = retenciones.reduce((s, r) => s + Number(r.valor), 0);
          const total = Number(factura.total);
          return {
            numero: `${factura.prefijo ?? ''}${factura.consecutivo}`,
            subtotal: Number(factura.subtotal),
            iva: Number(factura.total_iva),
            total,
            retenciones: retenciones.map((r) => ({
              tipo: r.tipo,
              nombre: r.nombre,
              tarifa: Number(r.tarifa),
              base: Number(r.base),
              valor: Number(r.valor),
            })),
            retenido,
            neto: Math.round((total - retenido) * 100) / 100,
            vence: doc.vence,
            asiento: lineas
              .filter((l) => !esCosto(l.codigo))
              .map((l) => ({
                codigo: l.codigo,
                nombre: l.nombre,
                centro: l.centro,
                debito: Number(l.debito),
                credito: Number(l.credito),
              })),
            costo: Number(costo?.costo ?? 0),
            pagos,
          };
        } finally {
          await t.query('ROLLBACK TO SAVEPOINT factura_previa');
        }
      },
      tx,
    );
  }

  /**
   * Qué productos no alcanzan para una venta, antes de emitirla: el modal
   * de convertir y la factura avisan con esto en vez de esperar el error. Las
   * cantidades del mismo producto se suman. Solo lee: la existencia puede
   * cambiar entre esta consulta y la emisión, y ahí decide el kardex.
   *
   * `nuncaTuvoEntrada` es el mismo criterio del kardex para rechazar un
   * descubierto (`exigirCostoConocido`): sin saldo o sin costo conocido.
   */
  async existencia(
    ctx: CtxEmpresa,
    lineas: Array<{ productoId: string; cantidad: number }>,
    tx?: Tx,
  ): Promise<{
    vendeSinExistencia: boolean;
    faltantes: Array<{
      productoId: string;
      codigo: string;
      nombre: string;
      pide: number;
      hay: number;
      faltan: number;
      nuncaTuvoEntrada: boolean;
    }>;
  }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const pedidas = new Map<string, number>();
        for (const l of lineas) {
          pedidas.set(
            l.productoId,
            (pedidas.get(l.productoId) ?? 0) + l.cantidad,
          );
        }
        const faltantes = [];
        for (const [productoId, pide] of pedidas) {
          const producto = await this.inventario.producto(ctx, productoId, t);
          if (producto === null) continue;
          const saldo = await this.inventario.saldoActual(ctx, productoId, t);
          const hay = saldo?.cantidad ?? 0;
          if (hay >= pide) continue;
          faltantes.push({
            productoId,
            codigo: producto.codigo,
            nombre: producto.nombre,
            pide,
            hay,
            faltan: Math.round((pide - hay) * 1e6) / 1e6,
            nuncaTuvoEntrada: saldo === null || !(saldo.costoPromedio > 0),
          });
        }
        return {
          vendeSinExistencia: await this.nucleo.tieneHechoOperativo(
            ctx,
            'VENDE_SIN_EXISTENCIA',
            t,
          ),
          faltantes,
        };
      },
      tx,
    );
  }

  /**
   * Cómo quedaría la factura de una cotización, sin emitirla: lo mismo que
   * `previo`, con el cliente y las líneas de la cotización.
   */
  async previoConversion(
    ctx: CtxEmpresa,
    cotizacionId: string,
    opciones: ConvertirCotizacionDto,
  ): ReturnType<FacturaService['previo']> {
    return this.tx.enContexto(ctx, async (t) => {
      const dto = await this.dtoDesdeCotizacion(
        ctx,
        cotizacionId,
        opciones,
        false,
        t,
      );
      return this.previo(ctx, dto, t);
    });
  }

  /**
   * Convierte una cotización EMITIDA en factura: el cliente, las líneas
   * (producto y cantidad) y el precio de cada una vienen de la cotización, no
   * se vuelven a pedir. Se factura al precio cotizado aunque el de lista haya
   * cambiado: es lo que se le ofreció al cliente. El IVA y el costo sí se
   * calculan a la fecha de la factura.
   */
  async convertirCotizacion(
    ctx: CtxEmpresa,
    cotizacionId: string,
    opciones: ConvertirCotizacionDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const dto = await this.dtoDesdeCotizacion(
        ctx,
        cotizacionId,
        opciones,
        true,
        t,
      );
      const factura = await this.crearInterno(ctx, dto, cotizacionId, t);

      await t.query(
        `UPDATE venta_documento SET estado = 'CONVERTIDA' WHERE id = $1`,
        [cotizacionId],
      );

      return factura;
    });
  }

  /**
   * La factura que sale de una cotización EMITIDA. Con `bloquear`, el
   * `SELECT ... FOR UPDATE` sobre la cotización es el candado: si dos
   * conversiones de la misma cotización llegan a la vez, la segunda espera
   * a que la primera termine y, cuando le toca, ya la ve `CONVERTIDA` y se
   * rechaza — sin este candado, las dos podrían leer `EMITIDA` a la vez y
   * facturar el mismo pedido dos veces. El previo no bloquea.
   */
  private async dtoDesdeCotizacion(
    ctx: CtxEmpresa,
    cotizacionId: string,
    opciones: ConvertirCotizacionDto,
    bloquear: boolean,
    t: Tx,
  ): Promise<CrearFacturaDto> {
    const bloqueo = fila<{ estado: string }>(
      await t.query(
        `SELECT estado FROM venta_documento
          WHERE id = $1 AND tipo = 'COTIZACION'
          ${bloquear ? 'FOR UPDATE' : ''}`,
        [cotizacionId],
      ),
    );
    if (bloqueo === undefined) {
      throw new NotFoundException('Cotización no encontrada.');
    }
    if (bloqueo.estado === 'CONVERTIDA') {
      throw new BadRequestException(
        'Esta cotización ya se convirtió en factura.',
      );
    }
    if (bloqueo.estado !== 'EMITIDA') {
      throw new BadRequestException('Esta cotización no está vigente.');
    }

    const cotizacion = await this.ventas.porId(
      ctx,
      'COTIZACION',
      cotizacionId,
      t,
    );

    return {
      terceroId: cotizacion.tercero_id,
      fecha: opciones.fecha,
      centroCostoId:
        opciones.centroCostoId ?? cotizacion.centro_costo_id ?? undefined,
      // Una cotización es solo de productos: la línea de concepto es de la
      // factura (Fase 8). El precio es el cotizado.
      lineas: cotizacion.lineas.map((l) => ({
        productoId: l.producto_id!,
        cantidad: Number(l.cantidad),
        precioUnitario: Number(l.precio_unitario),
      })),
      confirmaSinExistencia: opciones.confirmaSinExistencia ?? false,
      confirmaPrecioBajoCosto: opciones.confirmaPrecioBajoCosto ?? false,
      formaPago: opciones.formaPago,
      pagos: opciones.pagos,
      vence: opciones.vence,
      retenciones: opciones.retenciones,
      aplicar: opciones.aplicar,
    };
  }

  /**
   * `costearSalida` del kardex, con el código del producto en el mensaje: en
   * una factura de varias líneas, «Solo hay 3 en existencia» no dice cuál.
   * Si quien factura confirmó vender sin existencia pero la empresa no lo
   * tiene habilitado, se lo dice en vez de repetir el mismo mensaje.
   */
  private async costear(
    ctx: CtxEmpresa,
    codigo: string,
    productoId: string,
    cantidad: number,
    confirmaSinExistencia: boolean,
    t: Tx,
  ): Promise<{ costoUnitario: number; valorTotal: number; faltante: number }> {
    try {
      return await this.inventario.costearSalida(
        ctx,
        productoId,
        cantidad,
        t,
        confirmaSinExistencia,
      );
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      const motivo = e.message;
      if (
        confirmaSinExistencia &&
        /en existencia/.test(motivo) &&
        !(await this.nucleo.tieneHechoOperativo(ctx, 'VENDE_SIN_EXISTENCIA', t))
      ) {
        throw new BadRequestException(
          `${codigo}: ${motivo} Esta empresa no vende sin existencia: registre la compra o un ajuste de entrada.`,
        );
      }
      throw new BadRequestException(`${codigo}: ${motivo}`);
    }
  }

  /**
   * El cuerpo real de crear una factura, compartido por `crear()` (factura
   * directa, `origenCotizacionId = null`) y `convertirCotizacion()`
   * (`origenCotizacionId` es la cotización que se está convirtiendo, para
   * dejarla enlazada por `documento_origen_id`). Recibe `t` ya abierto en
   * los dos casos: `convertirCotizacion` necesita que el candado de la
   * cotización y la creación de la factura compartan una sola transacción.
   */
  private async crearInterno(
    ctx: CtxEmpresa,
    dto: CrearFacturaDto,
    origenCotizacionId: string | null,
    t: Tx,
    origen?: OrigenDeLaFactura,
    /** Si viene, se llena con los medios de pago ya resueltos (el previo los muestra). */
    salida?: {
      pagos: Array<{
        medio: string;
        cajaId?: string;
        cuentaBancariaId?: string;
        valor: number;
      }>;
    },
  ): Promise<VentaDocumentoDetalle> {
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

    if (!esDeHoy(dto.fecha)) {
      throw new BadRequestException(
        `La factura se emite con la fecha de hoy (${hoyEnColombia()}), no antes ni después.`,
      );
    }
    const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
      ctx,
      new Date(dto.fecha),
      t,
    );
    if (!periodoAbierto) {
      throw new BadRequestException(
        'El período de esta fecha está cerrado. No se puede facturar.',
      );
    }

    const tercero = await this.nucleo.buscarTercero(ctx, dto.terceroId, t);
    if (tercero === null || !tercero.activo) {
      throw new NotFoundException('Tercero no encontrado o inactivo.');
    }
    if (!tercero.esCliente) {
      throw new BadRequestException(
        'Este tercero no está marcado como cliente.',
      );
    }

    const responsableIva = await this.nucleo.esResponsableDeIva(
      ctx,
      dto.fecha,
      t,
    );

    // Por cada línea: el producto tiene que poder venderse (las dos
    // cuentas configuradas), y se costea ANTES de armar el asiento —
    // pero sin insertar nada en el kardex todavía.
    const entradas: LineaVentaEntrada[] = [];
    const cuentaIngresoDe: string[] = [];
    const cuentaCostoDe: string[] = [];
    const cuentaInventarioDe: string[] = [];
    /** Por línea: quién autorizó venderla bajo costo, o `null`. */
    const autorizoBajoCosto: Array<string | null> = [];
    /** `null` en la línea de concepto: no sale nada del kardex. */
    const costeos: Array<{
      costoUnitario: number;
      valorTotal: number;
      /** Unidades que salieron sin estar; `0` cuando había existencia. */
      faltante: number;
    } | null> = [];
    /** Por línea: el concepto y la cuenta a la que entró, o `null` si es producto. */
    const conceptoDe: Array<{ conceptoId: string; cuentaId: string } | null> =
      [];

    for (const l of dto.lineas) {
      if (l.conceptoId !== undefined) {
        const ingreso = await cuentaDeIngreso(
          this.nucleo,
          ctx,
          l.conceptoId,
          t,
        );
        cuentaIngresoDe.push(ingreso.cuentaId);
        cuentaCostoDe.push('');
        cuentaInventarioDe.push('');
        costeos.push(null);
        autorizoBajoCosto.push(null);
        conceptoDe.push(ingreso);
        entradas.push({
          cantidad: l.cantidad,
          precioUnitario: l.precioUnitario!,
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
      if (producto.cuenta_costo_venta_id === null) {
        throw new BadRequestException(
          `El producto ${producto.codigo} no tiene cuenta de costo de venta configurada.`,
        );
      }
      if (producto.cuenta_ingreso_id === null) {
        throw new BadRequestException(
          `El producto ${producto.codigo} no tiene cuenta de ingreso configurada.`,
        );
      }

      // El precio digitado en la línea manda —el pactado con el cliente, o el
      // de la cotización que se convierte—; sin digitar, el de lista. Un
      // precio de lista en cero cuenta como "sin precio": la línea saldría en
      // cero y el asiento fallaría más abajo con un mensaje contable que no le
      // dice nada a quien está facturando.
      const precio = resolverPrecio(
        l.precioUnitario,
        await this.inventario.precioVigente(ctx, l.productoId!, t),
      );
      if (precio === null) {
        throw new BadRequestException(
          `El producto ${producto.codigo} no tiene un precio de venta configurado.`,
        );
      }

      // `confirmaSinExistencia` es la confirmación de quien factura. No
      // alcanza por sí sola: si la empresa no habilitó el descubierto, el
      // kardex rechaza la salida igual, y si el producto nunca tuvo una
      // entrada tampoco hay costo con el que valorarla.
      const costeo = await this.costear(
        ctx,
        producto.codigo,
        l.productoId!,
        l.cantidad,
        dto.confirmaSinExistencia ?? false,
        t,
      );

      // Vender por debajo del costo promedio es una pérdida contable en el
      // momento de emitir, no un problema que aparezca al cierre. Se bloquea, y
      // solo un DIRECTOR puede levantarlo —quien vende no se autoriza a sí
      // mismo un descuento con pérdida—; la línea guarda quién lo hizo.
      const margen = evaluarMargen(precio, costeo.costoUnitario, l.cantidad);
      if (margen.bajoCosto) {
        if (dto.confirmaPrecioBajoCosto !== true) {
          throw new BadRequestException(
            `El producto ${producto.codigo} se vendería por debajo de su costo: cuesta ${costeo.costoUnitario} y el precio de la línea es ${precio}. La venta perdería ${margen.perdidaTotal}.`,
          );
        }
        if (!ctx.roles.includes('DIRECTOR')) {
          throw new BadRequestException(
            `Vender ${producto.codigo} por debajo de su costo lo tiene que autorizar un DIRECTOR.`,
          );
        }
        autorizoBajoCosto.push(ctx.usuarioId);
      } else {
        autorizoBajoCosto.push(null);
      }

      cuentaIngresoDe.push(producto.cuenta_ingreso_id);
      cuentaCostoDe.push(producto.cuenta_costo_venta_id);
      cuentaInventarioDe.push(producto.cuenta_inventario_id);
      costeos.push(costeo);
      conceptoDe.push(null);
      entradas.push({
        cantidad: l.cantidad,
        precioUnitario: precio,
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
      'FACTURA_VENTA',
      t,
      dto.fecha,
    );

    // Lo que el cliente nos retiene. No baja el total de la factura: baja lo
    // que nos van a pagar, y por eso el débito de cartera es el total MENOS lo
    // retenido, con lo retenido debitado aparte contra su propia cuenta.
    const retenciones = await this.resolverRetenciones(
      ctx,
      dto.retenciones ?? [],
      dto.fecha,
      totales.total,
      totales.totalIva,
      t,
    );
    const totalRetenido = retenciones.reduce((acc, r) => acc + r.valor, 0);

    // Se genera el id ANTES de asentar: el asiento necesita `origenId`
    // apuntando a esta factura, y la factura todavía no existe como fila
    // — mismo patrón que `KardexService.asentarAjuste` con su movimiento.
    const documentoId = randomUUID();

    // Las autorretenciones (especial y venta al SIMPLE) y el aviso si lo que
    // el cliente dice que retuvo no cuadra con la norma (motor, Fase 4). No
    // tocan lo que se cobra: la autorretención la paga la empresa.
    const motor = await this.retenciones.confirmarVenta(
      ctx,
      {
        documentoId,
        terceroId: dto.terceroId,
        fecha: dto.fecha,
        subtotal: totales.subtotal,
        iva: totales.totalIva,
        registradas: {
          renta: retenciones
            .filter((r) => r.tipo === 'RENTA')
            .reduce((s, r) => s + r.valor, 0),
          iva: retenciones
            .filter((r) => r.tipo === 'IVA')
            .reduce((s, r) => s + r.valor, 0),
        },
      },
      t,
    );

    // Lo que pagan los anticipos y saldos a favor del cliente, sin mover
    // caja: se valida contra lo que tiene y no puede pasar del neto.
    const aplicar = dto.aplicar ?? [];
    if (aplicar.length > 0) {
      if (this.cruces === undefined) {
        throw new Error('FacturaService sin CruceCarteraService.');
      }
      await this.cruces.validarAlFacturar(ctx, dto.terceroId, aplicar, t);
    }
    const aplicadoCentavos = aplicar.reduce(
      (s, a) => s + Math.round(a.valor * 100),
      0,
    );
    const netoCentavos = Math.round((totales.total - totalRetenido) * 100);
    if (aplicadoCentavos > netoCentavos) {
      throw new BadRequestException(
        `Los anticipos y saldos a favor suman ${aplicadoCentavos / 100} y la factura es por ${netoCentavos / 100}: sobra lo aplicado.`,
      );
    }
    const faltaCentavos = netoCentavos - aplicadoCentavos;
    const cubierta = aplicar.length > 0 && faltaCentavos === 0;

    // La forma de pago se valida acá, con lo retenido ya calculado y antes de
    // asentar: de contado se cobra lo que el cliente efectivamente paga, que
    // es el total menos lo que nos retuvo y menos lo que ya pagó con sus
    // anticipos. Si ellos la cubren, no hay nada más que cobrar.
    // Si la cubren, los medios que vengan no cobran nada: se ignoran —quien
    // factura no tiene por qué saber el neto exacto antes del previo—.
    const formaPago = cubierta
      ? ({ ok: true, valores: [] } as const)
      : validarFormaPago(
          dto.formaPago,
          dto.pagos?.map((p) => p.valor),
          faltaCentavos / 100,
        );
    if (!formaPago.ok) {
      throw new BadRequestException(formaPago.motivo);
    }
    // La base lo sostiene con `ck_venta_vence`; acá se dice en palabras.
    if (dto.vence !== undefined && dto.vence < dto.fecha) {
      throw new BadRequestException(
        'La factura no puede vencer antes de la fecha en que se emite.',
      );
    }
    const pagos = (cubierta ? [] : (dto.pagos ?? [])).map((p, i) => ({
      ...p,
      valor: formaPago.valores[i],
    }));
    if (salida !== undefined) salida.pagos = pagos;

    // El asiento: débito cartera por lo que queda por cobrar, débito de las
    // retenciones que nos practicaron, crédito ingreso por línea, crédito IVA
    // si aplica, y el par costo/inventario por línea — débito costo de venta,
    // crédito inventario, mismo valor los dos.
    //
    // De contado la plata no pasa por cartera: el mismo asiento la debita en
    // cada caja o banco por donde entró, con el renglón diciendo dónde. Un
    // solo asiento por factura, aunque se reparta entre caja y banco.
    const mediosContado =
      dto.formaPago === 'CONTADO'
        ? await this.ventas.mediosDeContado(ctx, pagos, t)
        : [];
    // El anticipo que se aplica sale de 280505 en este mismo asiento: la plata
    // ya había entrado cuando el cliente la dejó, así que no se mueve caja.
    const anticipos = aplicar.filter((a) => a.tipo === 'ANTICIPO');
    const conceptoAnticipo =
      anticipos.length > 0
        ? await this.nucleo.conceptoPorCodigo(ctx, 'NG-ANTICIPO-CLIENTE', t)
        : null;
    if (conceptoAnticipo !== null && conceptoAnticipo.cuenta === null) {
      throw new BadRequestException(
        'Falta la cuenta de anticipos de clientes (280505).',
      );
    }
    // Lo que queda en Clientes: el neto menos lo que entra ya a caja o banco y
    // menos los anticipos. El saldo a favor se queda acá: ya está en 130505.
    const carteraCentavos =
      netoCentavos -
      mediosContado.reduce((s, m) => s + Math.round(m.valor * 100), 0) -
      anticipos.reduce((s, a) => s + Math.round(a.valor * 100), 0);
    const lineasAsiento: LineaAsientoDto[] = [
      ...mediosContado.map((m) => ({
        cuentaId: m.cuentaId,
        debito: m.valor,
        credito: 0,
        detalle: `Recibido en ${m.nombre}`,
      })),
      ...anticipos.map((a) => ({
        cuentaId: conceptoAnticipo!.cuenta!.id,
        terceroId: dto.terceroId,
        conceptoId: conceptoAnticipo!.id,
        debito: a.valor,
        credito: 0,
        detalle: 'Anticipo del cliente aplicado',
      })),
      ...(carteraCentavos > 0
        ? [
            {
              cuentaId: cuentaCartera.id,
              terceroId: dto.terceroId,
              debito: carteraCentavos / 100,
              credito: 0,
            },
          ]
        : []),
      // Un activo: es impuesto nuestro pagado por anticipado, no un menor
      // ingreso. Registrarlo como menor ingreso diría que vendimos menos de lo
      // que vendimos.
      ...retenciones.map((r) => ({
        cuentaId: r.cuentaId,
        terceroId: dto.terceroId,
        debito: r.valor,
        credito: 0,
      })),
    ];
    lineas.forEach((l, i) => {
      lineasAsiento.push({
        cuentaId: cuentaIngresoDe[i],
        debito: 0,
        credito: l.subtotal,
      });
    });
    if (cuentaIvaId !== null) {
      lineasAsiento.push({
        cuentaId: cuentaIvaId,
        // La cuenta de IVA generado exige base gravable —el motor la rechaza
        // sin ella, `fn_exigencias_cuenta`—: el medio magnético pide base e
        // impuesto por separado. La base es el subtotal gravado del
        // documento entero, no por línea: el asiento agrega el IVA en una
        // sola cuenta sin importar si hubo tarifas mixtas.
        baseGravable: totales.subtotal,
        debito: 0,
        credito: totales.totalIva,
      });
    }
    lineasAsiento.push(...motor.lineasAsiento);
    // El par costo/inventario solo en las de producto: un servicio no sale de
    // ninguna bodega. Con costo cero tampoco: serían dos líneas en cero, y el
    // asiento no admite una línea sin débito ni crédito. El kárdex registra la
    // salida igual.
    costeos.forEach((costeo, i) => {
      if (costeo === null || costeo.valorTotal === 0) return;
      lineasAsiento.push({
        cuentaId: cuentaCostoDe[i],
        debito: costeo.valorTotal,
        credito: 0,
      });
      lineasAsiento.push({
        cuentaId: cuentaInventarioDe[i],
        debito: 0,
        credito: costeo.valorTotal,
      });
    });

    // El centro de costo de la factura (D3, D4: uno por factura): el elegido,
    // el del usuario, el de la sede de la caja si es de contado, el de por
    // defecto. El asiento lo pone en el ingreso y en el costo; el inventario y
    // la cartera son balance y no lo llevan.
    const centroCostoId = await this.nucleo.centroPropuesto(
      ctx,
      {
        elegido: dto.centroCostoId,
        cajaId: pagos.find((p) => p.medio === 'CAJA')?.cajaId,
      },
      t,
    );

    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: dto.fecha,
        glosa: `Factura de venta ${numero.numero}${glosaContado(mediosContado.map((m) => m.nombre))}${anticipos.length > 0 ? ' · con anticipo' : ''}`,
        lineas: lineasAsiento,
        centroCostoId: centroCostoId ?? undefined,
      },
      { origenTipo: 'VENTA', origenId: documentoId },
      t,
    );

    // A crédito sin vence: el plazo del cliente (PC25).
    const plazo =
      dto.formaPago === 'CREDITO' && !dto.vence
        ? await diasDePlazo(t, dto.terceroId, 'cliente')
        : null;
    const documento = fila<VentaDocumentoResumen>(
      await t.query(
        `INSERT INTO venta_documento
             (id, empresa_id, tipo, tercero_id, fecha, prefijo, consecutivo,
              resolucion_id, documento_origen_id, subtotal, total_iva, total,
              asiento_id, creado_por, documento_leido_id, retencion_aviso, vence,
              centro_costo_id)
           VALUES ($1, $2, 'FACTURA', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           RETURNING ${CAMPOS_DOCUMENTO}`,
        [
          documentoId,
          ctx.empresaId,
          dto.terceroId,
          dto.fecha,
          numero.prefijo,
          numero.consecutivo,
          numero.resolucionId,
          origenCotizacionId,
          totales.subtotal,
          totales.totalIva,
          totales.total,
          asiento.id,
          ctx.usuarioId,
          origen?.documentoLeidoId ?? null,
          motor.aviso,
          dto.formaPago === 'CREDITO'
            ? (dto.vence ?? venceDesdePlazo(dto.fecha, plazo))
            : null,
          centroCostoId,
        ],
      ),
    );
    if (documento === undefined) {
      throw new BadRequestException('No se pudo crear la factura.');
    }

    const lineasInsertadas: VentaDocumentoLineaResumen[] = [];
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      const insertada = fila<VentaDocumentoLineaResumen>(
        await t.query(
          `INSERT INTO venta_documento_linea
               (empresa_id, venta_documento_id, orden, producto_id, cantidad,
                precio_unitario, iva_tarifa, subtotal, iva_valor, total, costo_unitario,
                precio_bajo_costo_autorizado_por, concepto_id, cuenta_id, detalle)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
            costeos[i]?.costoUnitario ?? null,
            autorizoBajoCosto[i],
            conceptoDe[i]?.conceptoId ?? null,
            conceptoDe[i]?.cuentaId ?? null,
            conceptoDe[i] === null ? null : dto.lineas[i].detalle!.trim(),
          ],
        ),
      );
      if (insertada === undefined) {
        throw new BadRequestException(
          'No se pudo registrar una línea de la factura.',
        );
      }
      lineasInsertadas.push(insertada);
    }

    // Las retenciones, con la tarifa y la base con las que se calcularon: un
    // certificado de retención se explica con la tarifa de SU año, y si el
    // catálogo cambia el año que viene, esta fila tiene que seguir diciendo lo
    // mismo que el papel que se le entregó al cliente.
    for (const r of retenciones) {
      await t.query(
        `INSERT INTO venta_retencion
           (empresa_id, venta_documento_id, tipo, concepto, cuenta_id, base, tarifa, valor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ctx.empresaId,
          documento.id,
          r.tipo,
          r.concepto,
          r.cuentaId,
          r.base,
          r.tarifa,
          r.valor,
        ],
      );
    }

    // Recién ahora se escribe el kardex — el asiento y la factura ya
    // existen, así que `descontarPorVenta` los enlaza, no los adivina.
    for (let i = 0; i < lineas.length; i++) {
      const costeo = costeos[i];
      const productoId = dto.lineas[i].productoId;
      if (costeo === null || productoId === undefined) continue;
      await this.inventario.descontarPorVenta(
        ctx,
        productoId,
        lineas[i].cantidad,
        dto.fecha,
        `Factura de venta ${numero.numero}`,
        asiento.id,
        t,
        dto.confirmaSinExistencia ?? false,
      );

      // Lo que salió sin estar queda anotado con la factura que lo sacó: es
      // la lista de qué hay que comprar, y el rastro de por qué el kardex de
      // ese producto quedó en rojo. `costeos[i].faltante` lo calculó el
      // kardex cuando costeó, dentro del mismo candado.
      const faltante = costeo.faltante;
      if (faltante > 0) {
        await t.query(
          `INSERT INTO venta_faltante
             (empresa_id, venta_documento_id, producto_id, cantidad_faltante,
              costo_referencia, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ctx.empresaId,
            documento.id,
            productoId,
            faltante,
            costeo.costoUnitario,
            ctx.usuarioId,
          ],
        );
      }
    }

    // De contado, el cobro entra en esta misma transacción: los movimientos
    // de caja o banco quedan ligados al asiento de la factura —que ya lleva la
    // plata—, con el mismo candado y las mismas validaciones de un cobro
    // posterior: si la caja está cerrada, la factura no se emite. Quien factura puede cobrar acá aunque no tenga el rol CAJA:
    // es el mostrador, la plata la recibe quien vende.
    // Lo que pagan los anticipos y saldos a favor queda como cruce, antes del
    // cobro: el cobro de contado es solo por lo que falta.
    if (aplicar.length > 0) {
      await this.cruces!.registrarAlFacturar(
        ctx,
        {
          facturaId: documento.id,
          terceroId: dto.terceroId,
          asientoId: asiento.id,
          fecha: dto.fecha,
          aplicar,
        },
        t,
      );
    }

    if (dto.formaPago === 'CONTADO' && pagos.length > 0) {
      const cobrada = await this.ventas.cobrarEnTx(
        ctx,
        documento.id,
        { fecha: dto.fecha, pagos },
        t,
        undefined,
        asiento.id,
      );
      return { ...cobrada, lineas: lineasInsertadas };
    }
    if (aplicar.length > 0) {
      // Sin nada más que cobrar: el documento como quedó con lo aplicado.
      const aplicada = await this.ventas.ajustarPagadoEnTx(
        ctx,
        documento.id,
        0,
        t,
      );
      return { ...aplicada, lineas: lineasInsertadas };
    }

    return { ...documento, lineas: lineasInsertadas };
  }
  /**
   * Las retenciones que el cliente nos practica, calculadas contra el catálogo
   * del año del documento.
   *
   * Solo entra lo que el cliente **efectivamente** retuvo: a diferencia de
   * compras —donde la empresa es el agente y responde ante la DIAN por lo que
   * debió retener—, acá la decisión no es nuestra. Lo que hacemos es registrar
   * lo que el comprobante de retención dice, con el valor calculado para que
   * cuadre contra ese papel.
   */
  private async resolverRetenciones(
    ctx: CtxEmpresa,
    retenciones: RetencionVentaDto[],
    fecha: string,
    total: number,
    /** El IVA de la factura: la base del ReteIVA que nos practican. */
    ivaFactura: number,
    t: Tx,
  ): Promise<
    Array<{
      tipo: string;
      concepto: string;
      cuentaId: string;
      base: number;
      tarifa: number;
      valor: number;
    }>
  > {
    if (retenciones.length === 0) return [];

    const resueltas = [];
    for (const r of retenciones) {
      const calculada = await this.retenciones.calcular(
        ctx,
        {
          conceptoId: r.conceptoId,
          base: r.base,
          fecha,
          // La tarifa que el cliente nos aplica depende de si NOSOTROS
          // declaramos renta, no de él. Una empresa que factura declara: si
          // algún día hace falta el caso contrario, sale de la configuración.
          declaranteRenta: true,
          ivaDocumento: ivaFactura,
          lado: 'NOS_RETIENEN',
        },
        t,
      );
      if (calculada === null) continue;
      resueltas.push({
        tipo: calculada.tipo,
        concepto: calculada.concepto,
        cuentaId: calculada.cuentaId,
        base: calculada.base,
        tarifa: calculada.tarifa,
        valor: calculada.valor,
      });
    }

    const retenido = resueltas.reduce((acc, r) => acc + r.valor, 0);
    if (retenido > total) {
      throw new BadRequestException(
        'Lo retenido no puede superar el total de la factura.',
      );
    }
    return resueltas;
  }
}
