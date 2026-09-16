import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CrearCategoriaDto {
  @IsString()
  @Length(2, 60)
  nombre!: string;
}

/**
 * Una categoría no se borra: se desactiva. Borrarla dejaría sin clasificar a
 * los productos que la usaban sin que nadie se entere, y la FK la rechazaría
 * igual.
 */
export class EditarCategoriaDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
