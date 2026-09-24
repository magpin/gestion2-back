import { IsUUID } from 'class-validator';

/** El concepto va por la ruta (`PUT /tesoreria/configuracion/SOBRANTE`). */
export class FijarCuentaConceptoDto {
  @IsUUID()
  cuentaId!: string;
}
