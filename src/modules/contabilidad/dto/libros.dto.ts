import { IsISO8601, IsUUID } from 'class-validator';

export class RangoDto {
  @IsISO8601({ strict: true })
  desde!: string;

  @IsISO8601({ strict: true })
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
