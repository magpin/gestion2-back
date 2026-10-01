import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
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
  'PEDIDO_VENTA',
  'VENTA_HISTORICA',
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
 *
 * `correcciones`: lo que la persona cambió de lo leído —sobre todo lo dudoso—,
 * campo por valor. Un dato corregido deja de ser dudoso: lo decidió ella.
 */
export class ConfirmarDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  campos?: string[];

  @IsOptional()
  @IsObject()
  correcciones?: Record<string, string>;
}

/** Qué es un renglón que el cruce no pudo resolver. Uno de los dos, no los dos. */
export class RenglonResueltoDto {
  @IsInt()
  @Min(1)
  orden!: number;

  @IsOptional()
  @IsUUID()
  productoId?: string;

  @IsOptional()
  @IsUUID()
  cuentaId?: string;
}

/**
 * Registrar la compra de una factura leída.
 *
 * Mismo principio que `ConfirmarDto`: **los montos no viajan**. La cantidad, el
 * costo y la tarifa salen de lo que se leyó del documento, y acá viene solo lo
 * que una persona decidió — a quién apunta cada renglón que quedó sin resolver,
 * quién es el proveedor si no se encontró, y con qué número se registra.
 *
 * Poder mandar un monto sería poder registrar una compra por un valor que
 * ningún documento dice, con la trazabilidad de uno que sí.
 */
export class RegistrarCompraLeidaDto {
  /** Si el documento no traía número: una cuenta de cobro no lo trae. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  numero?: string;

  /** Si el proveedor no se encontró por NIT. */
  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RenglonResueltoDto)
  renglones?: RenglonResueltoDto[];

  /** Contado exige rol CAJA o DIRECTOR y sus medios: lo rechaza `POST /compras`. */
  @IsOptional()
  @IsIn(['CREDITO', 'CONTADO'])
  formaPago?: 'CREDITO' | 'CONTADO';

  /** El concepto de renta de los renglones que lo necesitaban, por su orden. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConceptoRentaLeidoDto)
  conceptosRenta?: ConceptoRentaLeidoDto[];

  /** «Sin retención», con el porqué. */
  @IsOptional()
  @IsString()
  @Length(5, 300)
  sinRetencionMotivo?: string;

  @IsOptional()
  @IsBoolean()
  zomacEnFactura?: boolean;

  /** Dónde se gastó; sin él, el que proponga el sistema. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

/** El concepto de retención de renta de un renglón del papel. */
export class ConceptoRentaLeidoDto {
  @IsInt()
  @Min(1)
  orden!: number;

  @IsString()
  @Length(2, 40)
  conceptoCodigo!: string;
}

/** Un archivo del lote: dónde quedó en el bucket y cómo se llamaba. */
export class ArchivoDeLoteDto {
  @IsString()
  @Length(10, 200)
  clave!: string;

  @IsString()
  @Length(1, 255)
  nombre!: string;
}

/** `POST /lotes`: los archivos que se soltaron juntos, en el orden en que llegaron. */
export class CrearLoteDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => ArchivoDeLoteDto)
  archivos!: ArchivoDeLoteDto[];
}

/** Por qué una lectura se deja sin registrar: «es la misma que CC-0924». */
export class DescartarLecturaDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/** Una factura del sistema anterior que una persona eligió cargar (fase 11). */
export class FacturaElegidaDto {
  /** Como se leyó: «FEV 13892». */
  @IsString()
  @Length(1, 40)
  numero!: string;

  /** Si ya se había cobrado entera. Si no, queda en la cartera. */
  @IsBoolean()
  pagada!: boolean;
}

/** Cuáles cargar de una lectura de ventas anteriores. Todas o ninguna. */
export class CargarVentasLeidasDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FacturaElegidaDto)
  facturas!: FacturaElegidaDto[];
}
