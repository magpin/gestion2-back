import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const TIPOS_CENTRO = ['PRODUCTIVO', 'APOYO', 'ADMINISTRATIVO'] as const;

/** El código de una cuenta de empresa: dígitos, hasta 20. */
const CODIGO = /^[0-9]{1,20}$/;

export class CrearCuentaEmpresaDto {
  @Matches(CODIGO, {
    message: 'El codigo de la cuenta son solo digitos, hasta 20',
  })
  codigo!: string;

  @IsString()
  @Length(2, 200)
  nombre!: string;

  /**
   * Ancestro en el Decreto 2650. Opcional: si no llega, el servicio lo deduce
   * tomando el prefijo más largo del código que exista en `cuenta_puc`. Mandarlo
   * a mano sirve para anclar más arriba a propósito.
   */
  @IsOptional()
  @Matches(/^[0-9]{1,6}$/, {
    message: 'El codigo PUC tiene entre 1 y 6 digitos',
  })
  codigoPuc?: string;

  /** Si no llega, se hereda de la cuenta del catálogo. */
  @IsOptional()
  @IsIn(['DEBITO', 'CREDITO'])
  naturaleza?: 'DEBITO' | 'CREDITO';

  @IsOptional()
  @IsBoolean()
  esAuxiliar?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeCentroCosto?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeBaseGravable?: boolean;
}

/**
 * El código no se edita: es la identidad de la cuenta y ya está escrito en los
 * asientos. Para renumerar se crea otra y se desactiva esta.
 */
export class EditarCuentaEmpresaDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nombre?: string;

  @IsOptional()
  @IsIn(['DEBITO', 'CREDITO'])
  naturaleza?: 'DEBITO' | 'CREDITO';

  @IsOptional()
  @IsBoolean()
  esAuxiliar?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeCentroCosto?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeBaseGravable?: boolean;
}

export class ListarCuentasEmpresaDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  soloAuxiliares?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  incluirInactivas?: 'true' | 'false';
}

/** Lo que el usuario confirmó de la sugerencia. Solo viajan los códigos aceptados. */
export class AplicarSugerenciaDto {
  @IsString({ each: true })
  @Matches(CODIGO, { each: true, message: 'Codigo de cuenta invalido' })
  codigos!: string[];
}

export class CrearCentroCostoDto {
  @IsString()
  @Length(1, 20)
  codigo!: string;

  @IsString()
  @Length(2, 120)
  nombre!: string;

  /** El centro que lo agrupa. Dos niveles: el padre no puede tener padre. */
  @IsOptional()
  @IsUUID()
  padreId?: string;

  @IsOptional()
  @IsUUID()
  sedeId?: string;

  @IsOptional()
  @IsIn(TIPOS_CENTRO)
  tipo?: (typeof TIPOS_CENTRO)[number];

  @IsOptional()
  @IsBoolean()
  esPorDefecto?: boolean;
}

/** `padreId` y `sedeId` en `null` los quitan; ausentes, no cambian. */
export class EditarCentroCostoDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  nombre?: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  padreId?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsUUID()
  sedeId?: string | null;

  @IsOptional()
  @IsIn(TIPOS_CENTRO)
  tipo?: (typeof TIPOS_CENTRO)[number];

  @IsOptional()
  @IsBoolean()
  esPorDefecto?: boolean;
}

export class ListarCentrosCostoDto {
  /** Llega como texto en la query string. */
  @IsOptional()
  @IsIn(['true', 'false'])
  soloActivos?: 'true' | 'false';
}

export class FijarManejoCentrosDto {
  @IsBoolean()
  activo!: boolean;
}

export class ParteRepartoDto {
  @IsUUID()
  centroCostoId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(100)
  porcentaje!: number;
}

/** «Arriendo: 60 % Norte, 40 % Sur». Las partes suman 100. */
export class GuardarRepartoDto {
  @IsString()
  @Length(2, 80)
  nombre!: string;

  /** Con qué se calcularon los porcentajes: «por metros cuadrados». */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  base?: string;

  @IsArray()
  @ArrayMinSize(2, { message: 'Un reparto va entre al menos dos centros.' })
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ParteRepartoDto)
  partes!: ParteRepartoDto[];
}

/** `null` le quita al usuario su centro. */
export class CentroDeUsuarioDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  centroCostoId!: string | null;
}

/**
 * «+ Crear cuenta auxiliar» desde un formulario: la madre y el nombre. El
 * código lo pone el servidor. `contexto` es de dónde se pidió (caja, banco,
 * producto…), solo informativo.
 */
export class CrearAuxiliarDto {
  @Matches(CODIGO, { message: 'Codigo de cuenta invalido' })
  madre!: string;

  @IsString()
  @Length(2, 120)
  nombre!: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  contexto?: string;
}

export class SiguienteAuxiliarDto {
  @Matches(CODIGO, { message: 'Codigo de cuenta invalido' })
  madre!: string;
}
