import { randomUUID } from 'node:crypto';

import { numeracionDe, type Numeracion } from '../../../common/numeracion';
import { diasDePlazo, venceDesdePlazo } from '../../../common/plazo';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { esFechaFutura, hoyEnColombia } from '../../../common/fecha';
import { mensajeNotasVivas, type NotaViva } from '../../../common/notas-vivas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type {
  CrearCompraDto,
  DevolverPagoDto,
  ListarComprasDto,
  PagarDto,
} from '../dto/compra.dto';
import {
  calcularDevolucionPago,
  calcularLineasCompra,
  calcularPago,
  netoAPagar,
  sumarPagos,
  totalRetenciones,
  validarFormaPago,
} from './compra.reglas';
import type { LineaCompraEntrada } from './compra.reglas';
import { cuentaInactiva } from '../../../common/contabilidad/cuenta-inactiva';

export interface CompraDocumentoResumen {
  id: string;
  /** FACTURA, o una de las dos notas — ver migración `0039`. */
  tipo: 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
  /** Quién emitió el documento: el proveedor (factura electrónica) o la empresa (soporte). */
  clase_documento: 'FACTURA_ELECTRONICA' | 'DOCUMENTO_SOPORTE';
  /** El soporte nace sin transmitir: no hay módulo DIAN (PC2). `null` en una factura. */
  transmision: 'SIN_TRANSMITIR' | 'TRANSMITIDO' | 'ACEPTADO' | null;
  cufe: string | null;
  /** La factura que la nota corrige. `null` en una factura. */
  documento_origen_id: string | null;
  tercero_id: string;
  tercero_nombre: string;
  /** Ya formateada para mostrar: `NIT 900123456-7`, `CC 19400748`. */
  tercero_identificacion: string;
  fecha: string;
  /** Cuándo vence lo pactado. `null`: «Por pagar» cuenta 30 días desde la fecha. */
  vence: string | null;
  /** La condición de pronto pago de la factura, si la trae. */
  descuento_pp_pct: string | null;
  descuento_pp_hasta: string | null;
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
  /** Nulo en una línea de gasto: ahí lo que se compró lo dice `detalle`. */
  producto_id: string | null;
  producto_codigo: string | null;
  producto_nombre: string | null;
  /** Contra qué cuenta se debitó: la del producto, o la del gasto. */
  cuenta_id: string;
  cuenta_codigo: string;
  cuenta_nombre: string;
  /** Qué se compró, cuando no es un producto del catálogo. */
  detalle: string | null;
  /** El concepto de una línea de gasto, si se eligió por concepto (0108). */
  concepto_id?: string | null;
  concepto_nombre?: string | null;
  cantidad: string;
  costo_unitario: string;
  iva_tarifa: string;
  subtotal: string;
  iva_valor: string;
  total: string;
  iva_descontable: boolean;
  /** La base del IVA cuando es el AIU (0102); `null`: el subtotal. */
  iva_base?: string | null;
}

export interface CompraRetencionResumen {
  id: string;
  compra_documento_id: string;
  concepto: string;
  cuenta_id: string;
  base: string;
  valor: string;
  /** Desde 0079. Las anteriores quedan con lo que se pudo deducir. */
  tipo?: 'RENTA' | 'IVA' | 'ICA' | null;
  concepto_nacional_id?: string | null;
  tarifa?: string | null;
  /** La retención calculada por el motor, con su explicación. */
  retencion_calculada_id?: string | null;
  /** IVA que asume la empresa (servicios del exterior): no bajó el neto. */
  asumida?: boolean;
  /** Solo en ReteICA: dónde se causó. */
  municipio_codigo?: string | null;
  /** El nombre del concepto de la ley, para mostrarlo (solo en el detalle). */
  concepto_nombre?: string | null;
}

export interface CompraDocumentoDetalle extends CompraDocumentoResumen {
  /** En una nota: la factura del proveedor que corrige. */
  documento_origen?: CompraDocumentoResumen | null;
  /** En una factura: las notas del proveedor que le apuntan. */
  notas?: CompraDocumentoResumen[];
  lineas: CompraDocumentoLineaResumen[];
  retenciones: CompraRetencionResumen[];
  /** Los ajustes de retención por cambio de norma que se anulan con ella. */
  ajustes_retencion?: Array<{ asiento: string; diferencia: number }>;
}

/** El AIU que la persona escribió, en su renglón (Fase 8, §8.13). */
function conAiu<R extends { orden: number }>(
  renglones: R[],
  aiu: Array<{ orden: number; aiu: number }> | undefined,
): Array<R & { aiu?: number }> {
  return renglones.map((r) => ({
    ...r,
    aiu: aiu?.find((a) => a.orden === r.orden)?.aiu,
  }));
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
                           tercero_id, fecha, vence, descuento_pp_pct, descuento_pp_hasta,
                           numero_factura_proveedor, estado, clase_documento, transmision, cufe,
                           subtotal, total_iva, total, total_retenciones, neto_a_pagar,
                           monto_pagado, asiento_id, retencion_decision, retencion_motivo,
                           (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.segundo_nombre, x.primer_apellido, x.segundo_apellido))
                              FROM tercero x WHERE x.id = tercero_id) AS tercero_nombre,
                           ${IDENTIFICACION_TERCERO} AS tercero_identificacion,
                           ${AJUSTE_NOTAS} AS ajuste_notas,
                           ${NETO_EFECTIVO} AS neto_efectivo,
                           ${PENDIENTE} AS pendiente,
                           ${SALDO_A_FAVOR} AS saldo_a_favor`;

const CAMPOS_LINEA = `id, compra_documento_id, orden, producto_id, cuenta_id, detalle, cantidad,
                       costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable, iva_base,
                       concepto_id,
                       (SELECT x.nombre FROM concepto_movimiento x WHERE x.id = concepto_id) AS concepto_nombre,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre,
                       (SELECT x.codigo FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_codigo,
                       (SELECT x.nombre FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_nombre`;

const CAMPOS_RETENCION = `id, compra_documento_id, concepto, cuenta_id, base, valor,
  tipo, concepto_nacional_id, tarifa, retencion_calculada_id, asumida, municipio_codigo`;

/** [BASE], suscrito a rango libre: `libre('2205','05', ...)` en `plan-cuentas.reglas.ts`. */
const CODIGO_CUENTA_PROVEEDORES = '220505';
/** [COND si responsable de IVA] */
const CODIGO_CUENTA_IVA_DESCONTABLE = '240810';
/** Comprobante de egreso — simétrico a como Ventas usa `CI` aunque sea a crédito. */
const CODIGO_COMPROBANTE_COMPRA = 'CE';

/**
 * Contra qué cuentas del PUC se puede debitar una línea de compra que no es
 * un producto.
 *
 * - **5** gastos, **6** costos de venta y **7** costos de producción: lo
 *   corriente —arriendo, servicios, honorarios, fletes—. La clase entera.
 * - **14 a 17**: cuando lo que se compra queda como activo —inventarios que
 *   no son del catálogo, un computador, un intangible, un diferido—. Acá van
 *   grupos y no la clase, porque la clase 1 también tiene la caja, los bancos
 *   y la cartera, y mandar un arriendo a un banco no es un error de tipeo:
 *   **es un asiento que cuadra y miente**.
 *
 * Fuera quedan los pasivos (2), el patrimonio (3) y los ingresos (4), donde
 * una compra no se debita nunca.
 */
const CUENTAS_DE_COMPRA = ['5', '6', '7', '14', '15', '16', '17'];

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
/**
 * De dónde salió una compra, cuando no la digitó una persona.
 *
 * **No viaja en el DTO, a propósito.** Si viniera del navegador, cualquiera
 * podría registrar una compra a mano y decir que salió de un documento que
 * María leyó: la trazabilidad valdría exactamente nada. Lo pone el servicio
 * que sí sabe —`ConfirmacionFacturaService`—, del lado del servidor.
 */
export interface OrigenDeLaCompra {
  documentoLeidoId: string;
  /**
   * La retención que el papel trae impresa, cuando María la leyó. Se registra
   * la calculada; si difiere, la diferencia queda escrita en el motivo.
   */
  retencionImpresa?: number | null;
}

@Injectable()
export class CompraService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly tesoreria: TesoreriaApi,
    private readonly retenciones: RetencionesApi,
  ) {}

  /**
   * Cómo quedaría la compra en el libro, sin guardarla (lienzo «Nueva
   * compra»: «Así queda en el libro»). Corre la creación de siempre dentro de
   * un punto de guardado y la deshace: el asiento que se muestra es el mismo
   * que se va a registrar, no una copia que se pueda separar.
   */
  async previo(
    ctx: CtxEmpresa,
    dto: CrearCompraDto,
    tx?: Tx,
  ): Promise<{
    numero: string;
    subtotal: number;
    iva: number;
    total: number;
    retenciones: number;
    /** Cada retención del motor, con la cuenta a la que va. */
    detalleRetenciones: Array<{
      tipo: string | null;
      nombre: string;
      tarifa: number | null;
      base: number;
      valor: number;
    }>;
    neto: number;
    vence: string | null;
    asiento: Array<{
      codigo: string;
      nombre: string;
      debito: number;
      credito: number;
    }>;
  }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        await t.query('SAVEPOINT compra_previa');
        try {
          const compra = await this.crear(
            ctx,
            {
              ...dto,
              numeroFacturaProveedor: dto.numeroFacturaProveedor || 'PREVIO',
            },
            undefined,
            t,
          );
          const asiento = filas<{
            codigo: string;
            nombre: string;
            debito: string;
            credito: string;
          }>(
            await t.query(
              `SELECT c.codigo, c.nombre, l.debito, l.credito
               FROM asiento_linea l JOIN empresa_cuenta c ON c.id = l.cuenta_id
              WHERE l.asiento_id = $1 ORDER BY l.orden`,
              [compra.asiento_id],
            ),
          );
          const retenciones = filas<{
            tipo: string | null;
            nombre: string;
            tarifa: string | null;
            base: string;
            valor: string;
          }>(
            await t.query(
              `SELECT r.tipo, c.nombre, r.tarifa, r.base, r.valor
               FROM compra_retencion r JOIN empresa_cuenta c ON c.id = r.cuenta_id
              WHERE r.compra_documento_id = $1 AND NOT coalesce(r.asumida, false)
              ORDER BY r.valor DESC`,
              [compra.id],
            ),
          );
          return {
            numero: compra.numero_factura_proveedor,
            subtotal: Number(compra.subtotal),
            iva: Number(compra.total_iva),
            total: Number(compra.total),
            detalleRetenciones: retenciones.map((x) => ({
              tipo: x.tipo,
              nombre: x.nombre,
              tarifa: x.tarifa === null ? null : Number(x.tarifa),
              base: Number(x.base),
              valor: Number(x.valor),
            })),
            retenciones: Number(compra.total_retenciones),
            neto: Number(compra.neto_a_pagar),
            vence: compra.vence,
            asiento: asiento.map((l) => ({
              codigo: l.codigo,
              nombre: l.nombre,
              debito: Number(l.debito),
              credito: Number(l.credito),
            })),
          };
        } finally {
          await t.query('ROLLBACK TO SAVEPOINT compra_previa');
        }
      },
      tx,
    );
  }

  /** La numeración del documento soporte: el siguiente número y cuántos quedan. */
  async numeracionSoporte(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<Numeracion | null> {
    return this.tx.enContexto(
      ctx,
      (t) => numeracionDe(t, 'DOCUMENTO_SOPORTE'),
      tx,
    );
  }

  async crear(
    ctx: CtxEmpresa,
    dto: CrearCompraDto,
    origen?: OrigenDeLaCompra,
    tx?: Tx,
  ): Promise<CompraDocumentoDetalle> {
    if (esFechaFutura(dto.fecha)) {
      throw new BadRequestException(
        'La fecha de la compra no puede ser posterior a hoy.',
      );
    }
    // Las de gasto quedan fuera de esta cuenta: dos renglones contra la
    // misma cuenta son corrientes en una factura de servicios, y cada uno
    // tiene su detalle.
    const productoIds = dto.lineas.flatMap((l) =>
      l.productoId === undefined ? [] : [l.productoId],
    );
    if (new Set(productoIds).size !== productoIds.length) {
      throw new BadRequestException(
        'No repitas el mismo producto en dos líneas — sumá la cantidad en una sola.',
      );
    }

    // Pagar de contado es sacar plata de una caja o un banco: lo hace quien
    // maneja la plata. A diferencia de la factura de venta —donde quien vende
    // recibe la plata en el mostrador—, cargar la factura de un proveedor no
    // lleva consigo el permiso de pagarla.
    if (
      dto.formaPago === 'CONTADO' &&
      !ctx.roles.some((r) => r === 'CAJA' || r === 'DIRECTOR')
    ) {
      throw new ForbiddenException(
        'Pagar una compra de contado lo hace alguien con rol CAJA o DIRECTOR. Regístrala a crédito y que caja la pague.',
      );
    }

    // El camino de antes del motor (retenciones digitadas) ya no existe.
    if ((dto.retenciones ?? []).length > 0) {
      throw new BadRequestException(RENTA_NO_SE_MANDA);
    }

    return this.tx.enContexto(
      ctx,
      async (t) => {
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

        const proveedor = await this.nucleo.buscarTercero(
          ctx,
          dto.terceroId,
          t,
        );
        if (proveedor === null || !proveedor.activo) {
          throw new NotFoundException('Tercero no encontrado o inactivo.');
        }
        if (!proveedor.esProveedor) {
          throw new BadRequestException(
            'Este tercero no está marcado como proveedor.',
          );
        }

        const { lineas, totales, cuentaDebitoDe, conceptoDe, renglonesRenta } =
          await this.prepararLineas(
            ctx,
            dto.lineas,
            proveedor,
            dto.fecha,
            t,
            dto.aiuRenglones,
          );
        // El id antes que todo: el motor guarda cada retención contra la compra.
        const documentoId = randomUUID();

        const cuentaProveedores = await this.nucleo.cuenta(
          ctx,
          CODIGO_CUENTA_PROVEEDORES,
          t,
        );
        if (cuentaProveedores === null) {
          throw cuentaInactiva('proveedores', CODIGO_CUENTA_PROVEEDORES);
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
            throw cuentaInactiva(
              'IVA descontable',
              CODIGO_CUENTA_IVA_DESCONTABLE,
            );
          }
          cuentaIvaId = cuentaIva.id;
        }

        // Renta: la calcula el motor con la ley a la fecha de la compra (plan
        // motor de retenciones, Fase 1). Lo deducido tiene que venir aceptado; si
        // no, el motor rechaza. «Sin retención» se acepta solo con motivo.
        const renta =
          dto.sinRetencionMotivo !== undefined
            ? null
            : await this.retenciones.confirmarRenta(
                ctx,
                {
                  terceroId: dto.terceroId,
                  fecha: dto.fecha,
                  zomacEnFactura: dto.zomacEnFactura,
                  pagadaConTarjeta: dto.pagadaConTarjeta,
                  municipioCompra: dto.municipioCodigo ?? null,
                  aportesSeguridadSocial: dto.aportesSeguridadSocial,
                  renglones: conAiu(renglonesRenta, dto.aiuRenglones),
                },
                {
                  conceptos: dto.conceptosRenta,
                  convenios: dto.conveniosRenta,
                },
                { tipo: 'COMPRA', id: documentoId },
                t,
              );
        const retencionDecision =
          renta === null ? 'DECIDIDO_SIN' : renta.decision;
        const rentaCalculada = (renta?.retenciones ?? [])
          .filter((r) => !r.asumida)
          .reduce((s, r) => s + r.valor, 0);
        const impresa = origen?.retencionImpresa ?? null;
        const retencionMotivo = [
          renta === null ? dto.sinRetencionMotivo!.trim() : renta.motivo,
          impresa !== null && Math.abs(impresa - rentaCalculada) >= 1
            ? `El papel decía ${pesos(impresa)} de retención; por norma corresponden ${pesos(rentaCalculada)} y registré eso.`
            : null,
        ]
          .filter((x) => x !== null)
          .join(' ');

        const retencionesResueltas: RetencionResuelta[] = [
          ...(renta?.retenciones ?? []).map((r) => ({
            tipo: r.impuesto,
            asumida: r.asumida,
            renglones: r.renglones,
            municipio: r.municipio,
            concepto: r.conceptoCodigo,
            conceptoNacionalId: r.conceptoNacionalId,
            cuentaId: r.cuentaId,
            base: r.base,
            valor: r.valor,
            tarifa: r.tarifa / 100,
            retencionCalculadaId: r.retencionCalculadaId,
          })),
        ];
        // El IVA asumido (servicios del exterior) no se le descuenta al
        // proveedor: la empresa lo declara y lo descuenta ella.
        const descontadas = retencionesResueltas.filter((r) => !r.asumida);
        if (totalRetenciones(descontadas) > totales.total) {
          throw new BadRequestException(
            'Lo retenido no puede superar el total de la factura.',
          );
        }
        // Sobre lo resuelto y no sobre lo que llegó: con el catálogo, el valor
        // recién se conoce después de calcularlo.
        const retenido = totalRetenciones(descontadas);
        const neto = netoAPagar(totales.total, retenido);

        // Con el neto ya conocido y antes de asentar: de contado se paga lo que
        // efectivamente sale, que es el total menos lo que retenemos.
        const formaPago = validarFormaPago(
          dto.formaPago,
          dto.pagos?.map((p) => p.valor),
          neto,
        );
        if (!formaPago.ok) {
          throw new BadRequestException(formaPago.motivo);
        }
        // La base lo sostiene (`ck_compra_vence`, `ck_compra_descuento_pp`);
        // acá se dice en palabras.
        if (dto.vence !== undefined && dto.vence < dto.fecha) {
          throw new BadRequestException(
            'La compra no puede vencer antes de la fecha de la factura.',
          );
        }
        if (
          (dto.descuentoProntoPagoPct === undefined) !==
          (dto.descuentoProntoPagoHasta === undefined)
        ) {
          throw new BadRequestException(
            'El pronto pago lleva el porcentaje y hasta cuándo aplica: los dos o ninguno.',
          );
        }
        if (
          dto.descuentoProntoPagoHasta !== undefined &&
          dto.descuentoProntoPagoHasta < dto.fecha
        ) {
          throw new BadRequestException(
            'El pronto pago no puede terminar antes de la fecha de la factura.',
          );
        }
        const pagos = (dto.pagos ?? []).map((p, i) => ({
          ...p,
          valor: formaPago.valores[i],
        }));

        // El documento soporte lo numera la empresa con su resolución, en la
        // misma transacción: si la compra falla, el número vuelve atrás.
        const soporte = dto.claseDocumento === 'DOCUMENTO_SOPORTE';
        const numeroDocumento = soporte
          ? (
              await this.nucleo.tomarConsecutivo(
                ctx,
                'DOCUMENTO_SOPORTE',
                t,
                dto.fecha,
              )
            ).numero
          : dto.numeroFacturaProveedor;

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
            cuentaId: cuentaDebitoDe[i],
            debito: l.valorKardex,
            credito: 0,
            // El concepto va en su línea: la vista de Gastos suma por él.
            ...(conceptoDe[i] !== null && { conceptoId: conceptoDe[i] }),
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
          // El IVA que asume la empresa: descontable si es responsable de IVA;
          // si no, es mayor valor de lo que compró.
          if (r.asumida) {
            const descontable = await this.regimenIncluye(ctx, dto.fecha, t, [
              'RESPONSABLE_IVA',
            ]);
            const cuenta = descontable
              ? (cuentaIvaId ??
                (
                  await this.nucleo.cuenta(
                    ctx,
                    CODIGO_CUENTA_IVA_DESCONTABLE,
                    t,
                  )
                )?.id)
              : cuentaDebitoDe[(r.renglones?.[0] ?? 1) - 1];
            if (cuenta === undefined) {
              throw cuentaInactiva(
                'IVA descontable',
                CODIGO_CUENTA_IVA_DESCONTABLE,
              );
            }
            lineasAsiento.push({
              cuentaId: cuenta,
              ...(descontable ? { baseGravable: r.base } : {}),
              debito: r.valor,
              credito: 0,
            });
          }
        }
        lineasAsiento.push({
          cuentaId: cuentaProveedores.id,
          terceroId: dto.terceroId,
          debito: 0,
          credito: neto,
        });

        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante.id,
            fecha: dto.fecha,
            glosa: soporte
              ? `Documento soporte ${numeroDocumento}`
              : `Factura de compra ${numeroDocumento}`,
            lineas: lineasAsiento,
          },
          { origenTipo: 'COMPRA', origenId: documentoId },
          t,
        );

        // A crédito sin vence: el plazo del proveedor (PC25).
        const plazo =
          dto.formaPago === 'CREDITO' && !dto.vence
            ? await diasDePlazo(t, dto.terceroId, 'proveedor')
            : null;
        const documento = fila<CompraDocumentoResumen>(
          await t.query(
            `INSERT INTO compra_documento
             (id, empresa_id, tercero_id, fecha, numero_factura_proveedor,
              subtotal, total_iva, total, total_retenciones, neto_a_pagar,
              asiento_id, creado_por, documento_leido_id,
              retencion_decision, retencion_motivo, retencion_impresa, vence,
              descuento_pp_pct, descuento_pp_hasta, clase_documento, transmision, cufe)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           RETURNING ${CAMPOS_DOCUMENTO}`,
            [
              documentoId,
              ctx.empresaId,
              dto.terceroId,
              dto.fecha,
              numeroDocumento,
              totales.subtotal,
              totales.totalIva,
              totales.total,
              retenido,
              neto,
              asiento.id,
              ctx.usuarioId,
              origen?.documentoLeidoId ?? null,
              retencionDecision,
              retencionMotivo,
              impresa,
              dto.formaPago === 'CREDITO'
                ? (dto.vence ?? venceDesdePlazo(dto.fecha, plazo))
                : null,
              dto.descuentoProntoPagoPct ?? null,
              dto.descuentoProntoPagoPct === undefined
                ? null
                : (dto.descuentoProntoPagoHasta ?? null),
              soporte ? 'DOCUMENTO_SOPORTE' : 'FACTURA_ELECTRONICA',
              soporte ? 'SIN_TRANSMITIR' : null,
              soporte ? null : (dto.cufe?.trim() ?? null),
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
               (empresa_id, compra_documento_id, orden, producto_id, cuenta_id, detalle,
                cantidad, costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable,
                iva_base, concepto_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING ${CAMPOS_LINEA}`,
              [
                ctx.empresaId,
                documento.id,
                i + 1,
                dto.lineas[i].productoId ?? null,
                // La cuenta contra la que se debitó, sea de producto o de gasto:
                // es la misma que acaba de ir al asiento.
                cuentaDebitoDe[i],
                dto.lineas[i].detalle ?? null,
                l.cantidad,
                l.costoUnitario,
                l.ivaTarifa,
                l.subtotal,
                l.ivaValor,
                l.total,
                l.ivaDescontable,
                l.ivaBase,
                conceptoDe[i],
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
               (empresa_id, compra_documento_id, concepto, cuenta_id, base, valor,
                tipo, concepto_nacional_id, tarifa, retencion_calculada_id, asumida,
                municipio_codigo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING ${CAMPOS_RETENCION}`,
              [
                ctx.empresaId,
                documento.id,
                r.concepto,
                r.cuentaId,
                r.base,
                r.valor,
                r.tipo,
                r.conceptoNacionalId,
                r.tarifa,
                r.retencionCalculadaId,
                r.asumida === true,
                r.municipio ?? null,
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
          // Un gasto no entra a la bodega.
          const productoId = dto.lineas[i].productoId;
          if (productoId === undefined) continue;
          await this.inventario.incrementarPorCompra(
            ctx,
            productoId,
            lineas[i].cantidad,
            lineas[i].costoUnitarioKardex,
            dto.fecha,
            `Factura de compra ${dto.numeroFacturaProveedor}`,
            asiento.id,
            t,
          );
        }

        // De contado, el pago entra en esta misma transacción y por el mismo
        // camino que un pago posterior: si la caja no alcanza o está cerrada, la
        // compra no queda registrada a medias.
        const resumen =
          dto.formaPago === 'CONTADO'
            ? await this.pagarEnTx(
                ctx,
                documento.id,
                { fecha: dto.fecha, pagos },
                t,
              )
            : documento;

        return {
          ...resumen,
          lineas: lineasInsertadas,
          retenciones: retencionesInsertadas,
        };
      },
      tx,
    );
  }

  /**
   * La retención de renta que llevaría esta compra, **sin registrar nada**: el
   * concepto de cada renglón con su certeza, lo que se retiene y por qué, y lo
   * que falta contestar. Es el mismo cálculo que corre al registrar —la misma
   * preparación de líneas y el mismo motor—, así que lo que muestra la
   * pantalla es lo que queda.
   *
   * Si ninguna fuente resolvió algún renglón, se le pregunta a la IA (fuente
   * 5) **fuera de la transacción**, y se vuelve a proponer con lo que dijo.
   * Solo aquí: al registrar se lee lo que ya quedó guardado.
   */
  async simularRenta(
    ctx: CtxEmpresa,
    dto: Pick<
      CrearCompraDto,
      | 'terceroId'
      | 'fecha'
      | 'lineas'
      | 'conceptosRenta'
      | 'zomacEnFactura'
      | 'pagadaConTarjeta'
      | 'municipioCodigo'
      | 'aportesSeguridadSocial'
      | 'aiuRenglones'
      | 'conveniosRenta'
    >,
    tx?: Tx,
  ) {
    const calcular = () =>
      this.tx.enContexto(
        ctx,
        async (t) => {
          const proveedor = await this.nucleo.buscarTercero(
            ctx,
            dto.terceroId,
            t,
          );
          if (proveedor === null || !proveedor.activo) {
            throw new NotFoundException('Tercero no encontrado o inactivo.');
          }
          const { renglonesRenta } = await this.prepararLineas(
            ctx,
            dto.lineas,
            proveedor,
            dto.fecha,
            t,
            dto.aiuRenglones,
          );
          const doc = {
            terceroId: dto.terceroId,
            fecha: dto.fecha,
            zomacEnFactura: dto.zomacEnFactura,
            pagadaConTarjeta: dto.pagadaConTarjeta,
            municipioCompra: dto.municipioCodigo ?? null,
            aportesSeguridadSocial: dto.aportesSeguridadSocial,
            renglones: conAiu(renglonesRenta, dto.aiuRenglones),
          };
          const propuesta = await this.retenciones.proponerRenta(
            ctx,
            doc,
            { conceptos: dto.conceptosRenta, convenios: dto.conveniosRenta },
            t,
          );
          return { doc, propuesta };
        },
        tx,
      );

    const primera = await calcular();
    if (
      tx !== undefined ||
      !primera.propuesta.renglones.some((r) => r.pideIa)
    ) {
      return primera.propuesta;
    }
    const nuevas = await this.retenciones.completarConIa(ctx, primera.doc);
    return nuevas === 0 ? primera.propuesta : (await calcular()).propuesta;
  }

  /**
   * Las líneas calculadas, la cuenta que debita cada una y lo que el motor de
   * renta necesita para clasificarlas. Una sola vez, para registrar y para
   * simular: si fueran dos, la pantalla podría mostrar una retención y
   * registrarse otra.
   */
  private async prepararLineas(
    ctx: CtxEmpresa,
    lineasDto: CrearCompraDto['lineas'],
    proveedor: { responsableIva: boolean },
    fecha: string,
    t: Tx,
    aiuRenglones?: CrearCompraDto['aiuRenglones'],
  ) {
    // Dos preguntas distintas (decisión 4 del plan): ¿hay IVA en la
    // línea? lo decide el PROVEEDOR. ¿ese IVA es descontable? lo decide
    // nuestra propia condición.
    const responsableIva = await this.regimenIncluye(ctx, fecha, t, [
      'RESPONSABLE_IVA',
    ]);

    const entradas: LineaCompraEntrada[] = [];
    /** Contra qué cuenta se debita cada línea: la del producto o la del gasto. */
    const cuentaDebitoDe: string[] = [];
    /** El concepto de cada línea de gasto elegida por concepto; `null` en las demás. */
    const conceptoDe: Array<string | null> = [];
    /** Lo que el motor de renta necesita de cada renglón para clasificarlo. */
    const pistas: Array<{
      texto: string | null;
      cuentaCodigo: string | null;
      sugerida: { concepto: string; nombreConcepto: string } | null;
    }> = [];

    for (const l of lineasDto) {
      // Una línea es un producto o un gasto. Lo único que cambia entre las
      // dos es de dónde salen la cuenta y la tarifa; el cálculo del valor,
      // el IVA y el asiento son idénticos.
      const producto =
        l.productoId === undefined
          ? null
          : await this.productoDeLinea(ctx, l.productoId, t);

      const gasto =
        producto === null ? await this.gastoDeLinea(ctx, l, t) : null;
      cuentaDebitoDe.push(gasto?.id ?? producto!.cuenta_inventario_id);
      conceptoDe.push(gasto?.conceptoId ?? null);
      pistas.push({
        texto: producto?.nombre ?? l.detalle ?? null,
        cuentaCodigo: gasto?.codigo ?? null,
        sugerida: gasto?.retencionSugerida ?? null,
      });

      entradas.push({
        cantidad: l.cantidad,
        costoUnitario: l.costoUnitario,
        // Tres condiciones y no dos: el proveedor, lo que se compró, y lo
        // que la factura efectivamente dice. `sinIva` solo baja a cero
        // —poner IVA donde el proveedor no lo cobró sería inventar un
        // descontable que nadie pagó—.
        ivaTarifa:
          proveedor.responsableIva && l.sinIva !== true
            ? producto === null
              ? (l.ivaTarifa ?? 0)
              : Number(producto.iva_tarifa)
            : 0,
        // PC23: un concepto marcado «No descontable» manda su IVA al gasto.
        ivaDescontable: responsableIva && gasto?.ivaCompra !== 'NO_DESCONTABLE',
        // Aseo, vigilancia, temporales y cooperativas: el IVA va sobre el AIU
        // (art. 462-1 ET, bug #16), el mismo que usa la retención de renta.
        aiu: aiuRenglones?.find((a) => a.orden === entradas.length + 1)?.aiu,
      });
    }

    const { lineas, totales } = calcularLineasCompra(entradas);
    const renglonesRenta = lineas.map((l, i) => ({
      orden: i + 1,
      subtotal: l.subtotal,
      iva: l.ivaValor,
      municipio: lineasDto[i].municipioCodigo ?? null,
      productoId: lineasDto[i].productoId ?? null,
      texto: pistas[i].texto,
      cuentaCodigo: pistas[i].cuentaCodigo,
      sugerida: pistas[i].sugerida,
    }));
    return { lineas, totales, cuentaDebitoDe, conceptoDe, renglonesRenta };
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
            // El nombre del concepto de la ley: el detalle no muestra el código
            // («RETEIVA_SERVICIOS») sino lo que es (bug 19).
            `SELECT ${CAMPOS_RETENCION},
                    (SELECT n.nombre FROM retencion_concepto_nacional n
                      WHERE n.id = compra_retencion.concepto_nacional_id) AS concepto_nombre
               FROM compra_retencion
              WHERE compra_documento_id = $1
              ORDER BY concepto`,
            [id],
          ),
        );

        // Lo que se anula con ella si se anula (Fase 8, §8.3).
        const ajustesRetencion = (
          await this.retenciones.ajustesDeCompra(ctx, id, t)
        ).map((a) => ({ asiento: a.asiento, diferencia: a.diferencia }));

        return {
          ...documento,
          lineas,
          retenciones,
          documento_origen: documentoOrigen,
          notas,
          ajustes_retencion: ajustesRetencion,
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
             FROM compra_documento WHERE id = $1
             FOR UPDATE`,
          [id],
        ),
      );
      if (documento === undefined) {
        throw new NotFoundException('Compra no encontrada');
      }
      if (documento.estado === 'ANULADA') {
        throw new BadRequestException('Esta compra ya está anulada.');
      }
      // Con notas vivas no se anula: primero las notas (`notas-vivas.ts`). El
      // `FOR UPDATE` de arriba es el candado contra una nota que se registre
      // mientras tanto: la nota bloquea la compra antes de mirarla
      // (`CompraNotaService.exigirCompraVigente`).
      const notasVivas = filas<NotaViva>(
        await t.query(
          `SELECT tipo, numero_factura_proveedor AS numero
             FROM compra_documento
            WHERE documento_origen_id = $1
              AND tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO')
              AND estado <> 'ANULADA'
            ORDER BY fecha, numero_factura_proveedor`,
          [id],
        ),
      );
      if (notasVivas.length > 0) {
        throw new ConflictException(mensajeNotasVivas('compra', notasVivas));
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
      // Solo las de mercancía: un gasto —un arriendo, un flete— no entró a la
      // bodega y no hay nada que sacar. Antes se miraban todas, y una compra
      // con una línea de gasto no se podía anular: el saldo de un producto
      // nulo daba cero.
      const lineas = filas<{
        producto_id: string | null;
        producto_codigo: string;
        cantidad: string;
      }>(
        await t.query(
          `SELECT ${CAMPOS_LINEA} FROM compra_documento_linea
            WHERE compra_documento_id = $1 AND producto_id IS NOT NULL
            ORDER BY orden`,
          [id],
        ),
      ) as Array<{
        producto_id: string;
        producto_codigo: string;
        cantidad: string;
      }>;
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

      // Lo que entró sale **al costo con que entró**, no al promedio de hoy:
      // al promedio, el kardex quedaba distinto de la cuenta del inventario
      // —la compra FM-101264 dejó $ 125.347,50 así—.
      await this.inventario.revertirPorAnulacion(
        ctx,
        documento.asiento_id,
        hoyEnColombia(),
        `Anulación de la compra ${documento.numero_factura_proveedor}: ${motivo}`,
        t,
      );

      // La retención de la compra también se anula: si no, seguía sumando en
      // el 350 y en el acumulado de honorarios del proveedor.
      await this.retenciones.anularRetencionesCompra(
        ctx,
        { compraId: id, fecha: hoyEnColombia(), motivo },
        t,
      );

      // Un ajuste por cambio de norma asentado sobre esta compra se anula con
      // ella: su retención ya se reversó arriba, y un asiento suelto dejaría
      // el 350 descuadrado (Fase 8, §8.3). Si su período está cerrado, la
      // anulación entera se rechaza con el porqué.
      for (const a of await this.retenciones.ajustesDeCompra(ctx, id, t)) {
        await this.contabilidad.anular(
          ctx,
          a.asientoId,
          `Anulación de la compra ${documento.numero_factura_proveedor}: ${motivo}`,
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
    return this.tx.enContexto(ctx, (t) => this.pagarEnTx(ctx, id, dto, t));
  }

  /**
   * El cuerpo de `pagar`, sobre una transacción ya abierta. Lo usa también
   * `crear` para la compra de contado — ver `VentaDocumentoService.cobrarEnTx`.
   */
  async pagarEnTx(
    ctx: CtxEmpresa,
    id: string,
    dto: PagarDto,
    t: Tx,
    /** El documento que agrupa este pago —«CE-000077»—, para el libro. */
    referencia?: string,
  ): Promise<CompraDocumentoResumen> {
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
      throw cuentaInactiva('proveedores', CODIGO_CUENTA_PROVEEDORES);
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
          concepto: `${referencia === undefined ? '' : `${referencia} · `}Pago de la compra ${documento.numero_factura_proveedor}${reparto}`,
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
    return this.tx.enContexto(ctx, (t) =>
      this.devolverPagoEnTx(ctx, id, dto, t),
    );
  }

  /**
   * El cuerpo de `devolverPago`, sobre una transacción ya abierta: lo usa la
   * anulación de un comprobante de egreso.
   */
  async devolverPagoEnTx(
    ctx: CtxEmpresa,
    id: string,
    dto: DevolverPagoDto,
    t: Tx,
    referencia?: string,
  ): Promise<CompraDocumentoResumen> {
    {
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
      // Lo que saldó un descuento por pronto pago o un anticipo no salió en
      // este pago: no vuelve como plata. Se mide sin eso y se suma al guardar.
      const noEnPlata = Number(
        fila<{ total: string }>(
          await t.query(
            `SELECT coalesce((SELECT sum(a.descuento) FROM comprobante_egreso_aplicacion a
                                JOIN comprobante_egreso c ON c.id = a.comprobante_id
                               WHERE c.estado = 'VIGENTE' AND a.compra_documento_id = $1), 0)
                  + coalesce((SELECT sum(x.valor - x.retencion_reversada) FROM cruce_pago x
                               WHERE x.estado = 'VIGENTE' AND x.destino_compra_id = $1), 0)
                    AS total`,
            [id],
          ),
        )?.total ?? 0,
      );
      const medido = calcularDevolucionPago(
        Number(documento.monto_pagado) - noEnPlata,
        valorTotal,
      );
      if (!medido.ok) {
        throw new BadRequestException(medido.motivo);
      }
      const resultado = { montoPagado: medido.montoPagado + noEnPlata };

      const cuentaProveedores = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_PROVEEDORES,
        t,
      );
      if (cuentaProveedores === null) {
        throw cuentaInactiva('proveedores', CODIGO_CUENTA_PROVEEDORES);
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
            concepto: `${referencia === undefined ? '' : `${referencia} · `}Devolución de pago de la compra ${documento.numero_factura_proveedor}${reparto}`,
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
    }
  }

  /**
   * Mueve lo pagado de una compra sin que salga plata: un descuento por
   * pronto pago, un anticipo que se le aplica. Espejo de
   * `VentaDocumentoService.ajustarPagadoEnTx`.
   */
  async ajustarPagadoEnTx(
    ctx: CtxEmpresa,
    id: string,
    delta: number,
    t: Tx,
  ): Promise<CompraDocumentoResumen> {
    const documento = fila<{
      estado: string;
      tipo: string;
      monto_pagado: string;
      neto_efectivo: string;
      numero_factura_proveedor: string;
    }>(
      await t.query(
        `SELECT estado, tipo, monto_pagado, ${NETO_EFECTIVO} AS neto_efectivo, numero_factura_proveedor
           FROM compra_documento WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (documento === undefined)
      throw new NotFoundException('Compra no encontrada');
    if (documento.tipo !== 'FACTURA' || documento.estado !== 'EMITIDA') {
      throw new BadRequestException(
        'Solo se ajusta lo pagado de una compra vigente.',
      );
    }
    const pagado = Math.round(Number(documento.monto_pagado) * 100);
    const cambio = Math.round(delta * 100);
    const pendiente =
      Math.round(Number(documento.neto_efectivo) * 100) - pagado;
    if (cambio > 0 && cambio > pendiente) {
      throw new BadRequestException(
        `A la compra ${documento.numero_factura_proveedor} solo le faltan ${Math.max(pendiente, 0) / 100}: no se le puede aplicar ${delta}.`,
      );
    }
    if (cambio < 0 && -cambio > pagado) {
      throw new BadRequestException(
        `De la compra ${documento.numero_factura_proveedor} no hay tanto pagado para devolver.`,
      );
    }
    const actualizado = fila<CompraDocumentoResumen>(
      await t.query(
        `UPDATE compra_documento SET monto_pagado = $2 WHERE id = $1 RETURNING ${CAMPOS_DOCUMENTO}`,
        [id, (pagado + cambio) / 100],
      ),
    );
    if (actualizado === undefined)
      throw new BadRequestException('No se pudo ajustar la compra.');
    return actualizado;
  }

  /** El producto de una línea, activo. Lo reusan las notas. */
  async productoDeLinea(ctx: CtxEmpresa, id: string, t: Tx) {
    const producto = await this.inventario.producto(ctx, id, t);
    if (producto === null || !producto.activo) {
      throw new BadRequestException(
        `El producto ${id} no existe o está inactivo.`,
      );
    }
    return producto;
  }

  /**
   * La cuenta contra la que se debita un gasto.
   *
   * Tres condiciones, y cada una evita un asiento imposible de corregir:
   *
   * - **Que exista y esté activa**, como cualquier cuenta del plan.
   * - **Que reciba movimientos.** Una cuenta que agrupa no acepta líneas de
   *   asiento; si se colara, la compra fallaría más adelante con un error de
   *   contabilidad que nadie relaciona con la línea que lo causó.
   * - **Que sea de una clase donde un gasto tenga sentido.** Mandar un
   *   arriendo a la cuenta de un banco o a la de un cliente no es un error de
   *   tipeo: es un asiento que cuadra y miente.
   */
  async cuentaDeGasto(ctx: CtxEmpresa, id: string, t: Tx): Promise<string> {
    return (await this.cuentaDeGastoConCodigo(ctx, id, t)).id;
  }

  /** Igual que `cuentaDeGasto`, con el código: le dice al motor qué se compró. */
  /**
   * La cuenta de una línea de gasto: la del concepto si se eligió concepto
   * —lo normal desde la Fase 6: la persona elige qué es, no la cuenta—, o la
   * que eligió un contador. Las dos pasan la misma validación.
   */
  async gastoDeLinea(
    ctx: CtxEmpresa,
    l: { conceptoId?: string; cuentaId?: string },
    t: Tx,
  ): Promise<{
    id: string;
    codigo: string;
    conceptoId: string | null;
    /** La retención que sugiere el concepto (PC23), para el motor. */
    retencionSugerida: { concepto: string; nombreConcepto: string } | null;
    /** Si el IVA de lo comprado con este concepto se descuenta (PC23). */
    ivaCompra: string | null;
  }> {
    if (l.conceptoId === undefined) {
      return {
        ...(await this.cuentaDeGastoConCodigo(ctx, l.cuentaId ?? '', t)),
        conceptoId: null,
        retencionSugerida: null,
        ivaCompra: null,
      };
    }
    const concepto = await this.nucleo.concepto(ctx, l.conceptoId, t);
    if (
      !concepto.activo ||
      concepto.automatico ||
      concepto.tipo === 'INGRESO'
    ) {
      throw new BadRequestException(
        `«${concepto.nombre}» no sirve para una línea de compra: elegí un concepto de gasto, costo o compra.`,
      );
    }
    if (concepto.cuenta === null) {
      throw new BadRequestException(
        `«${concepto.nombre}» todavía no tiene cuenta. Elegila en Contabilidad → Conceptos.`,
      );
    }
    return {
      ...(await this.cuentaDeGastoConCodigo(ctx, concepto.cuenta.id, t)),
      conceptoId: concepto.id,
      retencionSugerida:
        concepto.retencionSugerida === null
          ? null
          : {
              concepto: concepto.retencionSugerida,
              nombreConcepto: concepto.nombre,
            },
      ivaCompra: concepto.ivaCompra,
    };
  }

  async cuentaDeGastoConCodigo(
    ctx: CtxEmpresa,
    id: string,
    t: Tx,
  ): Promise<{ id: string; codigo: string }> {
    const cuenta = await this.nucleo.cuentaPorId(ctx, id, t);
    if (cuenta === null || !cuenta.activa) {
      throw new BadRequestException(
        'Esa cuenta no existe o está inactiva en el plan de la empresa.',
      );
    }
    if (!cuenta.es_auxiliar) {
      throw new BadRequestException(
        `La cuenta ${cuenta.codigo} agrupa y no recibe movimientos. Elegí una auxiliar.`,
      );
    }
    if (!CUENTAS_DE_COMPRA.some((p) => cuenta.codigo.startsWith(p))) {
      throw new BadRequestException(
        `La cuenta ${cuenta.codigo} no es de gasto, costo, compra ni de un activo que se compre. ` +
          'Una línea de compra se debita contra una de esas.',
      );
    }
    return { id: cuenta.id, codigo: cuenta.codigo };
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

type TipoRetencion = 'RENTA' | 'IVA' | 'ICA';

const pesos = (n: number) => `${Math.round(n).toLocaleString('es-CO')}`;

/** Una retención lista para el asiento y para `compra_retencion`. */
interface RetencionResuelta {
  tipo: TipoRetencion;
  /** IVA que asume la empresa (servicios del exterior): no baja el neto. */
  asumida?: boolean;
  /** Los renglones de la compra que forman la base. */
  renglones?: number[];
  /** Solo en ReteICA: dónde se causó. */
  municipio?: string | null;
  concepto: string;
  conceptoNacionalId: string | null;
  cuentaId: string;
  base: number;
  valor: number;
  /** Fracción: 0.025. */
  tarifa: number;
  retencionCalculadaId: string | null;
}

const RENTA_NO_SE_MANDA =
  'Las retenciones —en la fuente, de IVA y de ICA— las calcula el sistema con la ley a la fecha de la compra: no se mandan. Contestá el concepto de cada renglón, o registrala sin retención con el motivo.';
