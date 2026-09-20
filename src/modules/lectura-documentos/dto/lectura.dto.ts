import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

import type { TipoDocumento } from '../proveedores/extractor.puerto';

const TIPOS: readonly TipoDocumento[] = [
  'RUT',
  'CAMARA_COMERCIO',
  'RESOLUCION_DIAN',
];

/** Lo que el navegador manda antes de subir: qué va a subir y de qué tipo. */
export class UrlDeCargaDto {
  @IsIn(TIPOS)
  tipo!: TipoDocumento;

  @IsIn(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
  tipoMime!: string;
}

/**
 * Lo que manda cuando ya subió el archivo al bucket.
 *
 * La llave la eligió el servidor al firmar la subida, pero vuelve por el
 * navegador, así que acá se vuelve a mirar: tiene que ser una llave del prefijo
 * de **esta** empresa. Si no, cualquiera podría pedir que le leamos el RUT de
 * otra.
 */
export class RegistrarDocumentoDto {
  @IsIn(TIPOS)
  tipo!: TipoDocumento;

  @IsString()
  @Length(10, 200)
  clave!: string;
}

/**
 * Lo que se confirma. **No viajan los valores**: viajan los campos que la
 * persona aprobó, y el valor sale de lo que quedó guardado en la fila cuando se
 * leyó el documento.
 *
 * El plan proponía mandar los `DatoExtraido` de vuelta. Así es más corto y más
 * difícil de torcer: el navegador no puede aplicar un valor que nadie leyó de un
 * documento. Corregir un dato es lo que hace «Corregir algo», que abre el paso
 * manual —los mismos endpoints de siempre—.
 *
 * Sin `campos`, se aplica todo lo aplicable de ese documento.
 */
export class ConfirmarDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  campos?: string[];
}
