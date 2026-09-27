import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Una vigencia nueva de la tarifa de un concepto. La norma y quién la validó
 * son obligatorios: una tarifa sin su norma no se puede defender (R-D7).
 */
export class NuevaTarifaDto {
  @IsString()
  @Length(2, 40)
  conceptoCodigo!: string;

  /** Sin dato: aplica a los dos tipos de persona. */
  @IsOptional()
  @IsIn(['NATURAL', 'JURIDICA'])
  tipoPersona?: 'NATURAL' | 'JURIDICA';

  /** Sin dato: aplica declare o no. */
  @IsOptional()
  @IsBoolean()
  declarante?: boolean;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseUvt!: number;

  /** En porcentaje, como la escribe la norma: 2,5 % es 2.5. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  tarifaPorcentaje!: number;

  @IsISO8601({ strict: true })
  vigenciaDesde!: string;

  /** Solo si la norma ya dice hasta cuándo (una suspensión, por ejemplo). */
  @IsOptional()
  @IsISO8601({ strict: true })
  vigenciaHasta?: string;

  @IsString()
  @Length(3, 200)
  norma!: string;

  @IsOptional()
  @IsString()
  @Length(0, 400)
  observacion?: string;

  @IsString()
  @Length(2, 80)
  validadoPor!: string;

  @IsISO8601({ strict: true })
  validadoEn!: string;
}

/** La UVT de un año nuevo. La de un año ya cargado no se cambia. */
export class NuevaUvtDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  valor!: number;

  @IsString()
  @Length(3, 200)
  norma!: string;

  @IsString()
  @Length(2, 80)
  validadoPor!: string;

  @IsISO8601({ strict: true })
  validadoEn!: string;
}

/** Una actividad del municipio con su tarifa, por mil. */
export class TarifaIcaDto {
  @IsString()
  @Length(1, 20)
  codigoActividad!: string;

  @IsOptional()
  @IsString()
  @Length(4, 8)
  ciiu?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  descripcion?: string;

  @IsIn(['INDUSTRIAL', 'COMERCIAL', 'SERVICIOS', 'FINANCIERA'])
  tipo!: 'INDUSTRIAL' | 'COMERCIAL' | 'SERVICIOS' | 'FINANCIERA';

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(30)
  tarifaPorMil!: number;
}

/** Quién le retiene a quién en el municipio. `*` vale para cualquiera. */
export class FilaMatrizIcaDto {
  @IsString()
  @Length(1, 40)
  perfilPagador!: string;

  @IsString()
  @Length(1, 40)
  perfilBeneficiario!: string;

  @IsBoolean()
  retiene!: boolean;

  @IsOptional()
  @IsString()
  fundamento?: string;
}

/**
 * La ley de ICA de un municipio para un año: sus parámetros, sus tarifas por
 * actividad y su matriz. Con el acuerdo y quién lo validó (R-D7).
 */
export class NuevoIcaMunicipioDto {
  @IsString()
  @Length(5, 5)
  municipioCodigo!: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  anio!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseMinimaUvtCompras?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseMinimaUvtServicios?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(30)
  tarifaGeneralPorMil?: number;

  @IsBoolean()
  usaTarifaPorActividad!: boolean;

  @IsBoolean()
  acumulaEnPeriodo!: boolean;

  @IsIn(['MENSUAL', 'BIMESTRAL', 'TRIMESTRAL', 'ANUAL'])
  periodicidad!: 'MENSUAL' | 'BIMESTRAL' | 'TRIMESTRAL' | 'ANUAL';

  @IsString()
  @Length(3, 300)
  acuerdo!: string;

  @IsString()
  @Length(2, 80)
  validadoPor!: string;

  @IsISO8601({ strict: true })
  validadoEn!: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => TarifaIcaDto)
  tarifas?: TarifaIcaDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FilaMatrizIcaDto)
  matriz?: FilaMatrizIcaDto[];
}

/**
 * La tarifa de autorretención especial de renta de una actividad (CIIU), con
 * su vigencia y su norma (art. 1.2.6.8 DUR). Nunca se edita: se cierra la
 * abierta y se abre la nueva.
 */
export class NuevaAutorretencionDto {
  @IsString()
  @Length(4, 8)
  ciiu!: string;

  /** En porcentaje: 0,8 % es 0.8. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(10)
  tarifaPorcentaje!: number;

  @IsISO8601({ strict: true })
  vigenciaDesde!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  vigenciaHasta?: string;

  @IsString()
  @Length(3, 200)
  norma!: string;

  @IsString()
  @Length(2, 80)
  validadoPor!: string;

  @IsISO8601({ strict: true })
  validadoEn!: string;
}

/**
 * Recalcular las retenciones de un rango con la norma que rige hoy (plan motor
 * de retenciones, Fase 6, §6.3). El motivo es la norma que cambió: queda en la
 * bitácora y cada empresa lo ve junto a su diferencia.
 */
export class RecalcularRetencionesDto {
  @IsISO8601({ strict: true })
  desde!: string;

  @IsISO8601({ strict: true })
  hasta!: string;

  /** Sin esto, todas las empresas activas. */
  @IsOptional()
  @IsUUID()
  empresaId?: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;
}
