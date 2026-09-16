import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
}

/**
 * Base y valor de una retención practicada — los dos datos que trae
 * cualquier certificado real. Este corte no calcula tarifas ni bases
 * mínimas en UVT: ver "Qué NO entra" del plan.
 */
export class RetencionCompraDto {
  @IsIn(CONCEPTOS_RETENCION)
  concepto!: ConceptoRetencion;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  base!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

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
