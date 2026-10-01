import { IsUUID } from 'class-validator';

/** El concepto va por la ruta (`PUT /inventario/configuracion/SOBRANTE`). */
export class FijarCuentaConceptoDto {
  @IsUUID()
  cuentaId!: string;
}
