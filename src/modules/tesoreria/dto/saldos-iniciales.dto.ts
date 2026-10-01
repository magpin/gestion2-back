import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class SaldoCajaDto {
  @IsUUID()
  cajaId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

export class SaldoCuentaDto {
  @IsUUID()
  cuentaBancariaId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

/** El arranque: todo en un solo guardado y un solo asiento de apertura. */
export class CargarSaldosInicialesDto {
  /** El día de corte: la plata que había ese día. */
  @EsFechaCalendario()
  fecha!: string;

  /** De dónde salió la plata: decide la contrapartida del asiento. */
  @IsIn(['SOCIOS', 'ANTES'])
  origen!: 'SOCIOS' | 'ANTES';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaldoCajaDto)
  cajas!: SaldoCajaDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaldoCuentaDto)
  cuentas!: SaldoCuentaDto[];
}
