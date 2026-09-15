import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class LineaCotizacionDto {
  @IsUUID()
  productoId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /**
   * El precio de esta línea, solo cuando el producto todavía no tiene precio
   * de lista.
   *
   * No es negociar precio por documento —eso sigue afuera, ver "Descuentos por
   * línea o por documento" en `docs/planes/ventas-backend.md`—: es que una
   * cotización no puede quedar trabada porque a un producto recién importado
   * le falta un dato. Si el producto tiene precio vigente, manda el de lista y
   * esto se ignora.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  precioUnitario?: number;
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

  /**
   * "Sé que no hay existencia y la emito igual".
   *
   * No es un permiso: es una confirmación. La empresa tiene que haber
   * habilitado el descubierto (`inventario_configuracion.permite_existencia_negativa`)
   * y el producto tiene que tener un costo promedio conocido; si falta
   * cualquiera de las dos, la factura se rechaza aunque esto venga en `true`.
   * Lo que salga sin estar queda anotado en `venta_faltante`.
   */
  @IsOptional()
  @IsBoolean()
  confirmaSinExistencia?: boolean;
}
