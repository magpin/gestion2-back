import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsISO8601,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class LineaFacturaDto {
  @IsUUID()
  productoId!: string;

  /** Sin `precioUnitario`: se toma el precio de lista vigente — ver `CrearCotizacionDto`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

export class CrearFacturaDto {
  @IsUUID()
  terceroId!: string;

  @IsISO8601({ strict: true })
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaFacturaDto)
  @ArrayMinSize(1, { message: 'Una factura necesita al menos una línea' })
  lineas!: LineaFacturaDto[];
}
