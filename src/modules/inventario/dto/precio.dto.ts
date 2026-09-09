import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

export class CambiarPrecioDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  precioVenta!: number;

  @IsISO8601({ strict: true })
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
  @IsISO8601({ strict: true })
  desde?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  hasta?: string;
}
