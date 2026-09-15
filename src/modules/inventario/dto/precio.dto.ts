import { IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class CambiarPrecioDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  precioVenta!: number;

  @EsFechaCalendario()
  fechaInicio!: string;

  /** Por qué cambió. Opcional a propósito: ver el comentario en `0025`. */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  nota?: string;
}

/** La bitácora completa: todos los productos, filtrable por rango de fecha. */
export class ListarPreciosDto extends PaginacionDto {
  @IsOptional()
  @EsFechaCalendario()
  desde?: string;

  @IsOptional()
  @EsFechaCalendario()
  hasta?: string;
}
