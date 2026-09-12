import { IsUUID } from 'class-validator';

export class FijarCuentaDiferenciaDto {
  @IsUUID()
  cuentaDiferenciaId!: string;
}
