import { Type } from 'class-transformer';
import {
  IsBoolean,
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

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** De dónde sale o a dónde llega: una caja o una cuenta bancaria. */
export class ExtremoTrasladoDto {
  @IsIn(['CAJA', 'BANCO'])
  medio!: 'CAJA' | 'BANCO';

  @ValidateIf((o: ExtremoTrasladoDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: ExtremoTrasladoDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;
}

export class CrearTrasladoDto {
  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested()
  @Type(() => ExtremoTrasladoDto)
  origen!: ExtremoTrasladoDto;

  @ValidateNested()
  @Type(() => ExtremoTrasladoDto)
  destino!: ExtremoTrasladoDto;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  /** Vacío: «Consignación del efectivo», «Retiro para la caja»… */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  detalle?: string;

  /** El banco no cobró el 4×1000 aunque la regla diga que sí (cuenta marcada después, por ejemplo). */
  @IsOptional()
  @IsBoolean()
  sinGmf?: boolean;
}

export class AnularTrasladoDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/** La previsión del 4×1000: los extremos van planos en la consulta. */
export class GmfTrasladoDto {
  @IsIn(['CAJA', 'BANCO'])
  origenMedio!: 'CAJA' | 'BANCO';

  @IsUUID()
  origenId!: string;

  @IsIn(['CAJA', 'BANCO'])
  destinoMedio!: 'CAJA' | 'BANCO';

  @IsUUID()
  destinoId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}
