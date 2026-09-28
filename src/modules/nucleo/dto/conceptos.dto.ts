import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

import {
  TIPOS_CONCEPTO,
  TIPOS_FLUJO,
  type TipoConcepto,
  type TipoFlujo,
} from '../servicios/conceptos.reglas';

export class ListarConceptosDto {
  @IsOptional()
  @IsIn(TIPOS_CONCEPTO)
  tipo?: TipoConcepto;

  @IsOptional()
  @IsIn(['true', 'false'])
  incluirInactivos?: 'true' | 'false';
}

/** Un concepto propio de la empresa. Siempre colgado de un auxiliar suyo. */
export class CrearConceptoDto {
  @IsString()
  @Length(2, 80)
  nombre!: string;

  @IsString()
  @Length(2, 60)
  grupo!: string;

  @IsIn(TIPOS_CONCEPTO)
  tipo!: TipoConcepto;

  @IsUUID()
  cuentaId!: string;

  @IsOptional()
  @IsIn(TIPOS_FLUJO)
  tipoFlujo?: TipoFlujo;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  pistas?: string[];
}

/**
 * Lo que se cambia de un concepto. El tipo no: un gasto que pasa a ser «no
 * gasto» es otro concepto, y los asientos viejos seguirían diciendo lo otro.
 */
export class EditarConceptoDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  grupo?: string;

  @IsOptional()
  @IsUUID()
  cuentaId?: string;

  @IsOptional()
  @IsIn(TIPOS_FLUJO)
  tipoFlujo?: TipoFlujo;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  pistas?: string[];
}
