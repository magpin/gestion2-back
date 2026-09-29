import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Los seis conceptos que ya siembra `plan-cuentas.reglas.ts` (cuenta 2365xx). */
export const CONCEPTOS_RETENCION = [
  'HONORARIOS',
  'COMISIONES',
  'SERVICIOS',
  'ARRENDAMIENTOS',
  'COMPRAS',
  'OTROS',
] as const;
export type ConceptoRetencion = (typeof CONCEPTOS_RETENCION)[number];

/**
 * Una línea de compra: **o un producto, o un gasto**.
 *
 * Con producto, entra al inventario y se debita su cuenta. Con cuenta, no
 * toca inventario y se debita la que se eligió: es el arriendo, el internet,
 * los honorarios —la factura que más llega y la que hasta ahora no tenía
 * dónde ir—.
 *
 * Los dos a la vez no: una línea se debita contra una sola cuenta.
 */
export class LineaCompraDto {
  @ValidateIf(
    (o: LineaCompraDto) =>
      o.cuentaId === undefined && o.conceptoId === undefined,
  )
  @IsUUID()
  productoId?: string;

  /**
   * Qué es el gasto: «Arriendo», «Transporte, fletes y acarreos». La cuenta
   * la pone el concepto. Es lo normal desde la Fase 6 del menú nuevo; la
   * cuenta suelta queda para el contador.
   */
  @ValidateIf(
    (o: LineaCompraDto) =>
      o.productoId === undefined && o.cuentaId === undefined,
  )
  @IsUUID()
  conceptoId?: string;

  /**
   * La cuenta contra la que se debita el gasto. Una auxiliar activa del plan
   * de la empresa; el servicio verifica que reciba movimientos y que sea de
   * una clase donde un gasto tenga sentido.
   */
  @ValidateIf(
    (o: LineaCompraDto) =>
      o.productoId === undefined && o.conceptoId === undefined,
  )
  @IsUUID()
  cuentaId?: string;

  /**
   * Qué se compró. **Obligatorio en las de gasto**: una línea que dice
   * «519530 · 500.000» y nada más obliga a abrir la factura en papel para
   * saber qué fue. En las de producto sobra, y se ignora.
   */
  @ValidateIf((o: LineaCompraDto) => o.productoId === undefined)
  @IsString()
  @Length(2, 200)
  detalle?: string;

  /**
   * La tarifa de IVA del gasto. Solo en las de gasto: en las de producto la
   * pone el producto, que es donde vive esa decisión.
   */
  @ValidateIf((o: LineaCompraDto) => o.productoId === undefined)
  @IsOptional()
  @IsIn([0, 5, 19])
  ivaTarifa?: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /**
   * El costo que dice la factura del proveedor — no un precio de catálogo,
   * a diferencia de una línea de venta. Ver `docs/planes/compras-backend.md`,
   * decisión 3.
   */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costoUnitario!: number;

  /**
   * "Esta compra no llevó IVA, aunque el proveedor sea responsable y el
   * producto tenga tarifa."
   *
   * La tarifa normal sale de dos condiciones —si el proveedor es responsable y
   * cuánto liquida el producto— y eso cubre el caso corriente. Pero la factura
   * manda: una compra a un régimen simple, una exportación o un producto
   * excluido llegan sin IVA aunque las dos condiciones digan que sí, y el
   * sistema tiene que poder registrar lo que el papel dice.
   *
   * Solo baja a cero, nunca sube: poner IVA donde el proveedor no lo cobró
   * sería inventar un impuesto descontable que nadie pagó.
   */
  @IsOptional()
  @IsBoolean()
  sinIva?: boolean;

  /**
   * Si este renglón se causa en otro municipio que la compra —un servicio que
   * se presta en otra ciudad—. Decide dónde va su ReteICA (caso borde 9).
   */
  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;
}

/**
 * Base y valor de una retención practicada — los dos datos que trae
 * cualquier certificado real. Este corte no calcula tarifas ni bases
 * mínimas en UVT: ver "Qué NO entra" del plan.
 */
export class RetencionCompraDto {
  /**
   * El concepto del catálogo (`retencion_concepto`), con su tarifa y su base
   * mínima del año. Cuando viene, **el valor lo calcula el sistema** y el que
   * mande el cliente se ignora: el agente retenedor responde ante la DIAN por
   * lo que debió retener, no por lo que alguien escribió.
   */
  @IsOptional()
  @IsUUID()
  conceptoId?: string;

  /**
   * El concepto viejo, de las seis constantes. Sigue aceptándose para no
   * romper lo que ya factura, y desaparece cuando el catálogo esté cargado.
   */
  @IsOptional()
  @IsIn(CONCEPTOS_RETENCION)
  concepto?: ConceptoRetencion;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  base!: number;

  /** Obligatorio solo en el camino viejo: con `conceptoId` se calcula. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor?: number;
}

/**
 * Cómo se paga una compra al registrarla. Espejo de `FORMAS_PAGO` de ventas:
 * sin valor por defecto, crédito es una elección.
 */
export const FORMAS_PAGO = ['CREDITO', 'CONTADO'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

/**
 * El concepto de retención de renta de un renglón, cuando hacía falta
 * contestarlo: «La deduje» aceptada o cambiada, o «Te pregunto» respondida.
 * Lo que el sistema vio claro no hace falta mandarlo.
 */
export class ConceptoRentaDto {
  /** El renglón, empezando en 1, en el orden de `lineas`. */
  @IsInt()
  @Min(1)
  orden!: number;

  /** Un concepto de la ley: `COMPRAS_GENERALES`, `HONORARIOS`… */
  @IsString()
  @Length(2, 40)
  conceptoCodigo!: string;
}

/**
 * El AIU de un renglón, cuando la factura lo discrimina: temporales, aseo y
 * vigilancia retienen sobre el AIU (Fase 8, §8.13).
 */
export class AiuRenglonDto {
  @IsInt()
  @Min(1)
  orden!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  aiu!: number;
}

/** El convenio que la persona eligió aplicar a un renglón (Fase 8, §8.15). */
export class ConvenioRentaDto {
  @IsInt()
  @Min(1)
  orden!: number;

  @IsIn(['INTERESES', 'REGALIAS'])
  tipo!: 'INTERESES' | 'REGALIAS';
}

export class CrearCompraDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  /**
   * El número que el proveedor le puso a SU factura — dato externo. En el
   * documento soporte no se manda: lo pone la resolución de la empresa.
   */
  @ValidateIf((o: CrearCompraDto) => o.claseDocumento !== 'DOCUMENTO_SOPORTE')
  @IsString()
  @Length(1, 60)
  numeroFacturaProveedor!: string;

  /**
   * Factura electrónica del proveedor, o documento soporte que emite la
   * empresa cuando el vendedor no está obligado a facturar (Fase 7).
   */
  @IsOptional()
  @IsIn(['FACTURA_ELECTRONICA', 'DOCUMENTO_SOPORTE'])
  claseDocumento?: 'FACTURA_ELECTRONICA' | 'DOCUMENTO_SOPORTE';

  /** El CUFE de la factura electrónica, como dato: no se valida en la DIAN (PC2). */
  @IsOptional()
  @IsString()
  @Length(20, 200, {
    message:
      'El CUFE tiene entre 20 y 200 caracteres: copialo completo o dejalo vacío.',
  })
  cufe?: string;

  @ValidateNested({ each: true })
  @Type(() => LineaCompraDto)
  @ArrayMinSize(1, { message: 'Una compra necesita al menos una línea' })
  lineas!: LineaCompraDto[];

  /**
   * El camino anterior, de antes del motor. **Ya no se usa en compras**: las
   * retenciones —renta, IVA e ICA— las calcula el motor con la ley a la fecha
   * de la compra, y el servicio rechaza las que lleguen por acá.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RetencionCompraDto)
  retenciones?: RetencionCompraDto[];

  /** Los conceptos de renta contestados por renglón (plan motor, Fase 1). */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConceptoRentaDto)
  conceptosRenta?: ConceptoRentaDto[];

  /**
   * «Sin retención», con el porqué. Queda escrito en la compra y la revisión
   * lo respeta; sin motivo no se acepta.
   */
  @IsOptional()
  @IsString()
  @Length(5, 300)
  sinRetencionMotivo?: string;

  /**
   * Los aportes a salud y pensión que el proveedor persona natural soporta
   * con su planilla: bajan la base de la tabla del art. 383 (Fase 8, §8.14).
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  aportesSeguridadSocial?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AiuRenglonDto)
  aiuRenglones?: AiuRenglonDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConvenioRentaDto)
  conveniosRenta?: ConvenioRentaDto[];

  /** Si la factura informa la categoría ZOMAC del proveedor. */
  @IsOptional()
  @IsBoolean()
  zomacEnFactura?: boolean;

  /**
   * Pagada con tarjeta débito o crédito: la retención la practica la entidad
   * de la tarjeta, no la empresa (caso borde 6).
   */
  @IsOptional()
  @IsBoolean()
  pagadaConTarjeta?: boolean;

  /**
   * El municipio de la sede que recibe la compra. Sin dato, el de la sede
   * principal. Decide dónde se causa la ReteICA (Fase 3).
   */
  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  /**
   * `CONTADO` paga la compra entera —el neto, después de retenciones— en la
   * misma transacción que la registra, con los renglones de `pagos` —el que venga sin valor se lleva lo que
   * falte—.
   * `CREDITO` la deja pendiente y no lleva `pagos`. Pagar de contado exige
   * además el rol CAJA o DIRECTOR: quien carga la factura del proveedor no
   * necesariamente maneja la plata.
   */
  @IsIn(FORMAS_PAGO)
  formaPago!: FormaPago;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MedioPagoAlRegistrarDto)
  pagos?: MedioPagoAlRegistrarDto[];

  /**
   * Cuándo vence, si es a crédito. Sin ella, «Por pagar» cuenta 30 días desde
   * la fecha de la factura.
   */
  @IsOptional()
  @EsFechaCalendario()
  vence?: string;

  /**
   * La condición de pronto pago que trae la factura: «2 % pagando antes del
   * 30». Van juntos o ninguno; el comprobante de egreso la propone sola.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99.99)
  descuentoProntoPagoPct?: number;

  @IsOptional()
  @EsFechaCalendario()
  descuentoProntoPagoHasta?: string;
}

/**
 * Lo que hace falta para ver las retenciones antes de registrar: lo mismo que
 * la compra, sin forma de pago. Nada se guarda.
 */
export class SimularRentaCompraDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaCompraDto)
  @ArrayMinSize(1, { message: 'Una compra necesita al menos una línea' })
  lineas!: LineaCompraDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConceptoRentaDto)
  conceptosRenta?: ConceptoRentaDto[];

  @IsOptional()
  @IsBoolean()
  zomacEnFactura?: boolean;

  @IsOptional()
  @IsBoolean()
  pagadaConTarjeta?: boolean;

  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  /**
   * Los aportes a salud y pensión que el proveedor persona natural soporta
   * con su planilla: bajan la base de la tabla del art. 383 (Fase 8, §8.14).
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  aportesSeguridadSocial?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AiuRenglonDto)
  aiuRenglones?: AiuRenglonDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConvenioRentaDto)
  conveniosRenta?: ConvenioRentaDto[];
}

export class ListarComprasDto extends PaginacionDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;
}

/** Anular una compra. Motivo obligatorio, mismo criterio que `AnularVentaDto`. */
export class AnularCompraDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/**
 * Duplicado del `MEDIOS_PAGO`/`MedioPago` de `ventas/dto/venta.dto.ts`:
 * mismo motivo que `CAMPOS_DOCUMENTO` se repite entre servicios de
 * ventas — un DTO de un módulo no importa del DTO de otro.
 */
export const MEDIOS_PAGO = ['CAJA', 'BANCO'] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];

/**
 * Un renglón del pago: de dónde sale la plata y cuánta. Espejo de
 * `MedioPagoDto` de ventas, duplicado por el mismo motivo que `MEDIOS_PAGO`.
 */
export class MedioPagoDto {
  @IsIn(MEDIOS_PAGO)
  medio!: MedioPago;

  @ValidateIf((o: MedioPagoDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: MedioPagoDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

/**
 * Un renglón del pago al registrar la compra. Igual a `MedioPagoDto`, salvo
 * que el valor puede faltar y se lleva lo que quede por pagar — espejo de
 * `MedioPagoAlFacturarDto` de ventas.
 */
export class MedioPagoAlRegistrarDto {
  @IsIn(MEDIOS_PAGO)
  medio!: MedioPago;

  @ValidateIf((o: MedioPagoAlRegistrarDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: MedioPagoAlRegistrarDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor?: number;
}

/**
 * Paga una compra, total o parcialmente, **repartida entre uno o varios
 * medios** — ver `CobrarDto` de ventas, que explica el porqué. El concepto de
 * cada movimiento lo arma el servicio con el número de factura del proveedor,
 * no se pide acá.
 */
export class PagarDto {
  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => MedioPagoDto)
  @ArrayMinSize(1, { message: 'Un pago necesita al menos un medio' })
  pagos!: MedioPagoDto[];
}

/**
 * El proveedor nos devuelve parte de lo que le pagamos. Espejo de
 * `DevolverCobroDto` de ventas, declarado aparte por el mismo motivo.
 */
export class DevolverPagoDto {
  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => MedioPagoDto)
  @ArrayMinSize(1, {
    message: 'Una devolución necesita al menos un medio de entrada',
  })
  pagos!: MedioPagoDto[];
}
