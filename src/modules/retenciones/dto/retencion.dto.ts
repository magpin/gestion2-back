import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MaxLength,
} from 'class-validator';

export const TIPOS_RETENCION = ['RENTA', 'IVA', 'ICA'] as const;
export type TipoRetencion = (typeof TIPOS_RETENCION)[number];

/**
 * Lo que el servidor calcularía al guardar, para mostrarlo antes. Es el mismo
 * cálculo (`RetencionesApi.calcular`): la pantalla no repite la ley.
 */
export class PrevisualizarRetencionDto {
  @IsUUID()
  conceptoId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  base!: number;

  @IsISO8601({ strict: true })
  fecha!: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  declaranteRenta?: boolean;

  @IsOptional()
  @IsIn(['NATURAL', 'JURIDICA'])
  tipoPersona?: 'NATURAL' | 'JURIDICA';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  iva?: number;

  @IsOptional()
  @IsIn(['RETENEMOS', 'NOS_RETIENEN'])
  lado?: 'RETENEMOS' | 'NOS_RETIENEN';
}

/** Una versión nueva de los datos tributarios de un tercero, con su fecha. */
export class NuevoPerfilDto {
  @IsIn(['ORDINARIO', 'SIMPLE', 'NO_CONTRIBUYENTE', 'REGIMEN_ESPECIAL'])
  regimenRenta!:
    'ORDINARIO' | 'SIMPLE' | 'NO_CONTRIBUYENTE' | 'REGIMEN_ESPECIAL';

  @IsBoolean()
  declaranteRenta!: boolean;

  @IsBoolean()
  esResponsableIva!: boolean;

  @IsBoolean()
  esGranContribuyente!: boolean;

  @IsBoolean()
  esAutorretenedorRenta!: boolean;

  @IsOptional()
  @IsBoolean()
  esAgenteRetIva?: boolean;

  @IsOptional()
  @IsBoolean()
  esZomac?: boolean;

  @IsOptional()
  @IsIn(['MICRO', 'PEQUENA', 'MEDIANA', 'GRANDE'])
  zomacTamano?: 'MICRO' | 'PEQUENA' | 'MEDIANA' | 'GRANDE';

  @IsOptional()
  @Matches(/^[0-9]{4}$/, { message: 'El CIIU son cuatro dígitos.' })
  ciiuPrincipal?: string;

  /**
   * Persona natural: si contrató dos o más trabajadores para su actividad. Sin
   * eso, sus honorarios y servicios van por la tabla del art. 383 (§8.14).
   */
  @IsOptional()
  @IsBoolean()
  contratoDosOMasTrabajadores?: boolean;

  /** Desde cuándo rige: lo que diga su RUT o su resolución. */
  @IsISO8601({ strict: true })
  vigenciaDesde!: string;
}

/** El ICA de un proveedor en un municipio, desde una fecha (Fase 3). */
export class NuevoIcaTerceroDto {
  @Matches(/^[0-9]{5}$/)
  municipioCodigo!: string;

  @IsIn(['COMUN', 'PREFERENCIAL', 'NO_CONTRIBUYENTE'])
  icaRegimen!: 'COMUN' | 'PREFERENCIAL' | 'NO_CONTRIBUYENTE';

  @IsBoolean()
  esAutorretenedorIca!: boolean;

  @IsOptional()
  @IsBoolean()
  esAgenteRetIca?: boolean;

  /** El código de actividad del municipio: decide la tarifa donde va por actividad. */
  @IsOptional()
  @Matches(/^[0-9A-Za-z.-]{1,20}$/)
  codigoActividadLocal?: string;

  @IsOptional()
  @IsString()
  resolucion?: string;

  @IsISO8601({ strict: true })
  vigenciaDesde!: string;
}

/** Por qué no se ajusta una diferencia de un recálculo (Fase 6, §6.3). */
export class DescartarDiferenciaDto {
  @IsString()
  @MaxLength(500)
  motivo!: string;
}

/**
 * La residencia fiscal de un proveedor del exterior, con el período que cubre
 * su certificado (Fase 8, §8.15). Sin certificado vigente no hay convenio.
 */
export class NuevaResidenciaDto {
  @Matches(/^[A-Z]{2}$/, { message: 'El país va con su código de dos letras.' })
  paisCodigo!: string;

  @IsISO8601({ strict: true })
  certificadoDesde!: string;

  @IsISO8601({ strict: true })
  certificadoHasta!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  observacion?: string;
}

/** Por qué no se cambia el perfil que proponía una factura (Fase 8, §8.8). */
export class RechazarPropuestaPerfilDto {
  @IsString()
  @MaxLength(500)
  motivo!: string;
}
