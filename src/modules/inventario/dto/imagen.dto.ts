import { IsIn, IsString, Length } from 'class-validator';

/** Los tres formatos que el bucket acepta. Un `.exe` con nombre de foto no entra. */
const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class CargarImagenDto {
  @IsIn(TIPOS_IMAGEN)
  tipoMime!: (typeof TIPOS_IMAGEN)[number];
}

/** La llave que devolvió `POST :id/imagen/carga`, una vez subido el archivo. */
export class FijarImagenDto {
  @IsString()
  @Length(1, 300)
  clave!: string;
}
