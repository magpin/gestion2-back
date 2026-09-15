import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class LineaCotizacionDto {
  @IsUUID()
  productoId!: string;

  /**
   * Sin `precioUnitario`: este corte no negocia precio por documento — se
   * toma el precio de lista vigente del producto. Ver "Descuentos por
   * línea o por documento" en `docs/planes/ventas-backend.md`.
   */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

export class CrearCotizacionDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaCotizacionDto)
  @ArrayMinSize(1, { message: 'Una cotización necesita al menos una línea' })
  lineas!: LineaCotizacionDto[];
}

/**
 * Convertir una cotización en factura: solo pide la fecha de la factura
 * resultante — el cliente y las líneas vienen de la propia cotización, no
 * se vuelven a digitar. El precio y el costo de cada línea se recalculan
 * en ese momento contra el vigente, nunca se copia el precio congelado de
 * la cotización.
 */
export class ConvertirCotizacionDto {
  @EsFechaCalendario()
  fecha!: string;
}
