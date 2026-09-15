import { IsUUID } from 'class-validator';
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
}

export class AuxiliarTerceroDto extends RangoDto {
  @IsUUID()
  terceroId!: string;
}
