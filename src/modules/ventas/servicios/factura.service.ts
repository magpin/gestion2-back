import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
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
import {
  calcularLineas,
  evaluarMargen,
  validarFormaPago,
  type LineaVentaEntrada,
} from './venta.reglas';

const CAMPOS_LINEA = `id, venta_documento_id, orden, producto_id, cantidad, precio_unitario,
                       iva_tarifa, subtotal, iva_valor, total, costo_unitario`;

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

  /**
   * Convierte una cotización EMITIDA en factura: el cliente y las líneas
   * (producto + cantidad) vienen de la cotización, no se vuelven a pedir.
   * El precio, el IVA y el costo de cada línea se recalculan contra lo
   * vigente a la fecha de la factura — nunca se copia el precio congelado
   * que tenía la cotización, mismo criterio que ya sostiene `crear()`.
   *
   * El `SELECT ... FOR UPDATE` sobre la cotización es el candado: si dos
   * conversiones de la misma cotización llegan a la vez, la segunda espera
   * a que la primera termine y, cuando le toca, ya la ve `CONVERTIDA` y se
   * rechaza — sin este candado, las dos podrían leer `EMITIDA` a la vez y
   * facturar el mismo pedido dos veces.
   */
  async convertirCotizacion(
    ctx: CtxEmpresa,
    cotizacionId: string,
    opciones: ConvertirCotizacionDto,
  ): Promise<VentaDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const bloqueo = fila<{ estado: string }>(
        await t.query(
          `SELECT estado FROM venta_documento
            WHERE id = $1 AND tipo = 'COTIZACION'
            FOR UPDATE`,
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

      const dto: CrearFacturaDto = {
        terceroId: cotizacion.tercero_id,
        fecha: opciones.fecha,
        lineas: cotizacion.lineas.map((l) => ({
          productoId: l.producto_id,
          cantidad: Number(l.cantidad),
        })),
        confirmaSinExistencia: opciones.confirmaSinExistencia ?? false,
        confirmaPrecioBajoCosto: opciones.confirmaPrecioBajoCosto ?? false,
        formaPago: opciones.formaPago,
        pagos: opciones.pagos,
        vence: opciones.vence,
      };

      const factura = await this.crearInterno(ctx, dto, cotizacionId, t);

      await t.query(
        `UPDATE venta_documento SET estado = 'CONVERTIDA' WHERE id = $1`,
        [cotizacionId],
      );

      return factura;
    });
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
  ): Promise<VentaDocumentoDetalle> {
    const productoIds = dto.lineas.map((l) => l.productoId);
    if (new Set(productoIds).size !== productoIds.length) {
      throw new BadRequestException(
        'No repitas el mismo producto en dos líneas — sumá la cantidad en una sola.',
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
    const costeos: Array<{
      costoUnitario: number;
      valorTotal: number;
      /** Unidades que salieron sin estar; `0` cuando había existencia. */
      faltante: number;
    }> = [];

    for (const l of dto.lineas) {
      const producto = await this.inventario.producto(ctx, l.productoId, t);
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

      const precioVigente = await this.inventario.precioVigente(
        ctx,
        l.productoId,
        t,
      );
      // Un precio en cero también cuenta como "sin precio": la línea saldría en
      // cero y el asiento fallaría más abajo con un mensaje contable que no le
      // dice nada a quien está facturando.
      if (precioVigente === null || precioVigente <= 0) {
        throw new BadRequestException(
          `El producto ${producto.codigo} no tiene un precio de venta configurado.`,
        );
      }

      // `confirmaSinExistencia` es la confirmación de quien factura. No
      // alcanza por sí sola: si la empresa no habilitó el descubierto, el
      // kardex rechaza la salida igual, y si el producto nunca tuvo una
      // entrada tampoco hay costo con el que valorarla.
      const costeo = await this.inventario.costearSalida(
        ctx,
        l.productoId,
        l.cantidad,
        t,
        dto.confirmaSinExistencia ?? false,
      );

      // Vender por debajo del costo promedio es una pérdida contable en el
      // momento de emitir, no un problema que aparezca al cierre. Se bloquea, y
      // solo un DIRECTOR puede levantarlo —quien vende no se autoriza a sí
      // mismo un descuento con pérdida—; la línea guarda quién lo hizo.
      const margen = evaluarMargen(
        precioVigente,
        costeo.costoUnitario,
        l.cantidad,
      );
      if (margen.bajoCosto) {
        if (dto.confirmaPrecioBajoCosto !== true) {
          throw new BadRequestException(
            `El producto ${producto.codigo} se vendería por debajo de su costo: cuesta ${costeo.costoUnitario} y el precio de lista es ${precioVigente}. La venta perdería ${margen.perdidaTotal}.`,
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
      entradas.push({
        cantidad: l.cantidad,
        precioUnitario: precioVigente,
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
      throw new BadRequestException(
        `No existe o está inactiva la cuenta de cartera (${CODIGO_CUENTA_CARTERA}). Actívala en el plan de cuentas.`,
      );
    }

    let cuentaIvaId: string | null = null;
    if (totales.totalIva > 0) {
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

    // La forma de pago se valida acá, con lo retenido ya calculado y antes de
    // asentar: de contado se cobra lo que el cliente efectivamente paga, que
    // es el total menos lo que nos retuvo.
    const formaPago = validarFormaPago(
      dto.formaPago,
      dto.pagos?.map((p) => p.valor),
      totales.total - totalRetenido,
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
    const pagos = (dto.pagos ?? []).map((p, i) => ({
      ...p,
      valor: formaPago.valores[i],
    }));

    // El asiento: débito cartera por lo que queda por cobrar, débito de las
    // retenciones que nos practicaron, crédito ingreso por línea, crédito IVA
    // si aplica, y el par costo/inventario por línea — débito costo de venta,
    // crédito inventario, mismo valor los dos.
    const lineasAsiento: LineaAsientoDto[] = [
      {
        cuentaId: cuentaCartera.id,
        terceroId: dto.terceroId,
        debito: totales.total - totalRetenido,
        credito: 0,
      },
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
    lineas.forEach((_l, i) => {
      lineasAsiento.push({
        cuentaId: cuentaCostoDe[i],
        debito: costeos[i].valorTotal,
        credito: 0,
      });
      lineasAsiento.push({
        cuentaId: cuentaInventarioDe[i],
        debito: 0,
        credito: costeos[i].valorTotal,
      });
    });

    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: dto.fecha,
        glosa: `Factura de venta ${numero.numero}`,
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
              asiento_id, creado_por, documento_leido_id, retencion_aviso, vence)
           VALUES ($1, $2, 'FACTURA', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
          dto.formaPago === 'CREDITO' ? (dto.vence ?? null) : null,
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
                precio_bajo_costo_autorizado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING ${CAMPOS_LINEA}`,
          [
            ctx.empresaId,
            documento.id,
            i + 1,
            dto.lineas[i].productoId,
            l.cantidad,
            l.precioUnitario,
            l.ivaTarifa,
            l.subtotal,
            l.ivaValor,
            l.total,
            costeos[i].costoUnitario,
            autorizoBajoCosto[i],
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
      await this.inventario.descontarPorVenta(
        ctx,
        dto.lineas[i].productoId,
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
      const faltante = costeos[i].faltante;
      if (faltante > 0) {
        await t.query(
          `INSERT INTO venta_faltante
             (empresa_id, venta_documento_id, producto_id, cantidad_faltante,
              costo_referencia, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ctx.empresaId,
            documento.id,
            dto.lineas[i].productoId,
            faltante,
            costeos[i].costoUnitario,
            ctx.usuarioId,
          ],
        );
      }
    }

    // De contado, el cobro entra en esta misma transacción y por el mismo
    // camino que un cobro posterior —mismos movimientos de caja o banco, mismo
    // candado, mismas validaciones—: si la caja está cerrada, la factura no
    // se emite. Quien factura puede cobrar acá aunque no tenga el rol CAJA:
    // es el mostrador, la plata la recibe quien vende.
    if (dto.formaPago === 'CONTADO') {
      const cobrada = await this.ventas.cobrarEnTx(
        ctx,
        documento.id,
        { fecha: dto.fecha, pagos },
        t,
      );
      return { ...cobrada, lineas: lineasInsertadas };
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
