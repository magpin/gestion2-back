import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

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

  @IsISO8601({ strict: true })
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
