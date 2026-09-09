import { IsUUID } from 'class-validator';

export class FijarCuentaAjusteDto {
  @IsUUID()
  cuentaAjusteId!: string;
}
