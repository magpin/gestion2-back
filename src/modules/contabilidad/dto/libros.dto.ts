import { IsOptional, IsUUID } from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class RangoDto {
  @EsFechaCalendario()
  desde!: string;

  @EsFechaCalendario()
  hasta!: string;
}

export class MayorDto extends RangoDto {
  @IsUUID()
  cuentaId!: string;

  /** Solo las líneas de este centro de costo. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

export class AuxiliarTerceroDto extends RangoDto {
  @IsUUID()
  terceroId!: string;

  /** Solo las líneas de este centro de costo. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}
