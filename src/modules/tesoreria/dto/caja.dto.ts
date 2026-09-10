import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** PRINCIPAL vive en una sede; MENOR es el fondo fijo de toda la empresa. */
export const TIPOS_CAJA = ['PRINCIPAL', 'MENOR'] as const;

/**
 * La combinación tipo/sedeId no se valida acá: `ck_caja_sede` en la base es
 * quien decide, y el filtro de errores ya sabe traducirla. Duplicar la regla
 * en el DTO es mantenerla en dos lugares que tarde o temprano se separan.
 */
export class CrearCajaDto {
  @IsString()
  @Length(2, 200)
  nombre!: string;

  @IsIn(TIPOS_CAJA)
  tipo!: (typeof TIPOS_CAJA)[number];

  /** Obligatoria para PRINCIPAL, ausente para MENOR — lo exige `ck_caja_sede`. */
  @IsOptional()
  @IsUUID()
  sedeId?: string;

  /**
   * El auxiliar del plan donde vive esta caja. No se edita después de
   * creada: cambiarla dejaría el libro viejo apuntando a una cuenta que la
   * caja ya no dice usar — mismo criterio que `cuentaInventarioId` en
   * `producto`.
   */
  @IsUUID()
  cuentaId!: string;
}

export class EditarCajaDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nombre?: string;
}
