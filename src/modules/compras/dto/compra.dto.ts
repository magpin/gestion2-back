import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
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

export class LineaCompraDto {
  @IsUUID()
  productoId!: string;

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

export class CrearCompraDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  /** El número que el proveedor le puso a SU factura — dato externo. */
  @IsString()
  @Length(1, 60)
  numeroFacturaProveedor!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaCompraDto)
  @ArrayMinSize(1, { message: 'Una compra necesita al menos una línea' })
  lineas!: LineaCompraDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RetencionCompraDto)
  retenciones?: RetencionCompraDto[];

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
