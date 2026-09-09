import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

export class CargaInicialDto {
  /** La fecha del hecho, no la de digitación. */
  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costoUnitario!: number;

  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/** Misma forma que la carga inicial: fecha, cantidad, costo, motivo. */
export class EntradaAjusteDto extends CargaInicialDto {}

export class SalidaAjusteDto {
  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /** No pide costo: una salida se valora al promedio vigente, no a uno nuevo. */
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export class FiltroMovimientosDto extends PaginacionDto {
  @IsOptional()
  @IsUUID()
  productoId?: string;
}
