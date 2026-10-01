import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** La cabecera: el rango de fechas y los saldos que dice el banco. */
export class CrearExtractoDto {
  @EsFechaCalendario()
  fechaDesde!: string;

  @EsFechaCalendario()
  fechaHasta!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoInicialBanco!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoFinalBanco!: number;
}

export const TIPOS_LINEA_EXTRACTO = ['DEBITO', 'CREDITO'] as const;
export type TipoLineaExtracto = (typeof TIPOS_LINEA_EXTRACTO)[number];

/** Un renglón del extracto, digitado a mano. */
export class AgregarLineaExtractoDto {
  @EsFechaCalendario()
  fecha!: string;

  @IsString()
  @Length(3, 300)
  descripcion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  referencia?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsIn(TIPOS_LINEA_EXTRACTO)
  tipo!: TipoLineaExtracto;
}

/** Un renglón leído del archivo. `fila` es la del archivo, para señalarla si algo falla. */
export class LineaImportadaDto {
  @IsInt()
  @Min(1)
  fila!: number;

  @EsFechaCalendario()
  fecha!: string;

  /** Desde 1: el banco escribe "GMF" y nada más. */
  @IsString()
  @Length(1, 300)
  descripcion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  referencia?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsIn(TIPOS_LINEA_EXTRACTO)
  tipo!: TipoLineaExtracto;
}

/**
 * El extracto subido de un archivo, ya leído por el navegador: la cabecera,
 * las líneas, la huella del archivo y el mapeo de columnas que se usó, para
 * recordarlo el mes siguiente.
 */
export class ImportarExtractoDto extends CrearExtractoDto {
  @IsString()
  @Length(1, 255)
  archivoNombre!: string;

  @Matches(/^[0-9a-f]{64}$/, {
    message: 'La huella del archivo tiene que ser un SHA-256 en hexadecimal',
  })
  archivoHuella!: string;

  /** Lo interpreta el frontend; acá solo se guarda. */
  @IsObject()
  formato!: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1, { message: 'El archivo no trae ninguna línea' })
  @ArrayMaxSize(5000, {
    message: 'Un extracto de más de 5.000 líneas se sube por partes',
  })
  @ValidateNested({ each: true })
  @Type(() => LineaImportadaDto)
  lineas!: LineaImportadaDto[];
}

/** Los criterios que puede traer un cruce hecho desde la pantalla. `REGISTRADA` y `ANTERIOR` los pone el sistema. */
export const CRITERIOS_CONCILIACION = [
  'REFERENCIA',
  'MISMA_FECHA',
  'FECHA_CERCANA',
  'MANUAL',
] as const;

/** Unas líneas del extracto que explican unos movimientos del libro. */
export class GrupoConciliacionDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  lineaIds!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  movimientoIds!: string[];

  @IsIn(CRITERIOS_CONCILIACION)
  criterio!: (typeof CRITERIOS_CONCILIACION)[number];
}

/** Uno o varios cruces, todos o ninguno: "Aceptar los seguros" manda varios. */
export class ConciliarDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => GrupoConciliacionDto)
  grupos!: GrupoConciliacionDto[];
}

/**
 * Registrar en el libro lo que el banco cobró o abonó solo —4×1000,
 * comisiones, intereses—: una nota débito o crédito por línea, con la fecha y
 * el valor del banco, ya conciliada con su línea.
 */
export class RegistrarDesdeExtractoDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  lineaIds!: string[];

  @IsUUID()
  contraCuentaId!: string;

  @IsString()
  @Length(3, 300)
  concepto!: string;

  /** Solo si la contra cuenta exige tercero. */
  @IsOptional()
  @IsUUID()
  terceroId?: string;

  /** Si la contra cuenta es de ingreso, costo o gasto: a qué centro va. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

/**
 * Un cruce al que le falta la diferencia: registra la nota por lo que falta
 * —un cargo del banco, o la corrección de un error nuestro— y cruza todo junto.
 */
export class CompletarGrupoDto extends RegistrarDesdeExtractoDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  movimientoIds!: string[];
}

/** Error del banco: la línea queda sin cruzar, con el porqué. `null` la quita. */
export class NotaLineaDto {
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Length(3, 300)
  nota!: string | null;
}

/** `cuentaBancariaId` va por la ruta: el historial siempre es de UNA cuenta. */
export class ListarExtractosDto extends PaginacionDto {}

// -----------------------------------------------------------------------------
// Reglas del extracto
// -----------------------------------------------------------------------------

export class CrearReglaExtractoDto {
  /** Sin cuenta: vale para todas las cuentas bancarias de la empresa. */
  @IsOptional()
  @IsUUID()
  cuentaBancariaId?: string;

  @IsString()
  @Length(2, 80)
  nombre!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  palabras!: string[];

  @IsIn(TIPOS_LINEA_EXTRACTO)
  tipoLinea!: TipoLineaExtracto;

  @IsUUID()
  contraCuentaId!: string;

  @IsString()
  @Length(3, 300)
  concepto!: string;

  /** Si la contra cuenta es de ingreso, costo o gasto: a qué centro va. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

export class ActualizarReglaExtractoDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  nombre?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  palabras?: string[];

  @IsOptional()
  @IsUUID()
  contraCuentaId?: string;

  @IsOptional()
  @IsString()
  @Length(3, 300)
  concepto?: string;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  /** `null` le quita el centro: va al del usuario o al de por defecto. */
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsUUID()
  centroCostoId?: string | null;
}
