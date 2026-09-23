import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

import type { TipoDocumento } from '../proveedores/extractor.puerto';
import { TIPOS_SUBIBLES } from '../reglas/contenido';

/**
 * Lo que se puede mandar a leer. Los tres de configuración, más la factura de
 * compra —que se lee por otro camino y devuelve otra forma, pero entra por el
 * mismo endpoint: el archivo sube al bucket igual—.
 */
const TIPOS: readonly TipoDocumento[] = [
  'RUT',
  'CAMARA_COMERCIO',
  'RESOLUCION_DIAN',
  'FACTURA_COMPRA',
];

/** Lo que el navegador manda antes de subir: qué va a subir y de qué tipo. */
export class UrlDeCargaDto {
  /** Sin tipo: lo reconoce el servidor al registrar. */
  @IsOptional()
  @IsIn(TIPOS)
  tipo?: TipoDocumento;

  /** PDF, fotos, Excel, Word, CSV, XML, JSON o texto: `reglas/contenido.ts`. */
  @IsIn([...TIPOS_SUBIBLES.keys()])
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

/** Un archivo ya subido, sin decir qué es: el servidor lo mira. */
export class AnalizarDocumentoDto {
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
