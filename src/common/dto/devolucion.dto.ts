import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

import { EsFechaCalendario } from './fecha.decorator';

/** Devolver un anticipo, de un cliente o a un proveedor (PC19). */
export class DevolverAnticipoDto {
  @IsIn(['CAJA', 'BANCO'])
  medio!: 'CAJA' | 'BANCO';

  @IsOptional()
  @IsUUID()
  cajaId?: string;

  @IsOptional()
  @IsUUID()
  cuentaBancariaId?: string;

  @EsFechaCalendario()
  fecha!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsString()
  @Length(3, 200)
  motivo!: string;
}
