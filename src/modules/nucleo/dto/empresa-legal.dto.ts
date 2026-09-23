import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const TIPOS_REGIMEN = [
  'RESPONSABLE_IVA',
  'NO_RESPONSABLE_IVA',
  'RESPONSABLE_INC',
  'AGENTE_RETENEDOR_RENTA',
  'AGENTE_RETENEDOR_IVA',
  'AGENTE_RETENEDOR_ICA',
  'AUTORRETENEDOR_RENTA',
  'GRAN_CONTRIBUYENTE',
  'REGIMEN_SIMPLE',
  'REGIMEN_ORDINARIO',
  'ENTIDAD_SIN_ANIMO_DE_LUCRO',
  'EXENTO_RENTA',
] as const;

export class AbrirActividadDto {
  @Matches(/^[0-9]{4}$/, { message: 'El codigo CIIU tiene 4 digitos' })
  codigoCiiu!: string;

  /**
   * Opcional: si no llega, el servicio copia el nombre oficial de `ciiu_clase`.
   * Se guarda congelada a proposito —el CIIU cambia de version y la actividad
   * declarada en el RUT de hace tres anios tiene que seguir leyendose igual—, y
   * por eso se puede sobrescribir cuando el RUT dice algo distinto del catalogo.
   */
  @IsOptional()
  @IsString()
  @Length(3, 300)
  descripcion?: string;

  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;

  /** Tarifa municipal de ICA expresada por mil (ej. 4.14). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tarifaIcaPorMil?: number;

  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  @IsDateString()
  fechaInicio!: string;
}

export class AbrirRegimenDto {
  @IsIn(TIPOS_REGIMEN)
  tipoRegimen!: (typeof TIPOS_REGIMEN)[number];

  /** Código del anexo técnico DIAN: O-13, O-15, O-23, O-47, R-99-PN… */
  @IsOptional()
  @IsString()
  codigoResponsabilidadDian?: string;

  @IsOptional()
  @IsString()
  actoAdministrativo?: string;

  @IsDateString()
  fechaInicio!: string;
}

export class AbrirRepresentanteDto {
  @IsOptional()
  @IsIn(['PRINCIPAL', 'SUPLENTE'])
  tipoRepresentante?: 'PRINCIPAL' | 'SUPLENTE';

  @IsString()
  @Length(3, 200)
  nombreCompleto!: string;

  /** Se valida contra `tipo_documento_identidad`, no contra una lista escrita aca. */
  @Matches(/^[A-Z_]{2,20}$/, { message: 'Tipo de documento invalido' })
  tipoDocumento!: string;

  @IsString()
  @Length(3, 20)
  numeroDocumento!: string;

  @IsOptional()
  @IsString()
  cargo?: string;

  @IsDateString()
  fechaInicio!: string;
}

export class AbrirMatriculaDto {
  @IsString()
  @Length(1, 30)
  numeroMatricula!: string;

  @IsString()
  @Length(3, 120)
  camaraComercio!: string;

  @IsDateString()
  fechaMatricula!: string;

  @IsOptional()
  @IsDateString()
  fechaUltimaRenovacion?: string;

  @IsDateString()
  fechaInicio!: string;
}

/** Cerrar una vigencia. Es lo único que se puede cambiar de una fila histórica. */
export class CerrarVigenciaDto {
  @IsDateString()
  fechaFin!: string;
}

export class EditarConfiguracionContableDto {
  @IsOptional()
  @IsIn(['GRUPO_1', 'GRUPO_2', 'GRUPO_3'])
  grupoNiif?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  monedaFuncional?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  mesCierreFiscal?: number;

  @IsOptional()
  @IsIn(['PROMEDIO_PONDERADO', 'PEPS'])
  metodoValoracionInventario?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  decimalesValor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  decimalesCantidad?: number;

  @IsOptional()
  @IsBoolean()
  manejaCentroDeCosto?: boolean;
}

/**
 * Casilla 53 del RUT. El codigo se valida contra `responsabilidad_tributaria`
 * por clave foranea: un codigo que la DIAN no publica no entra.
 */
export class AbrirResponsabilidadRutDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  codigo!: number;

  @IsDateString()
  fechaInicio!: string;
}

/**
 * Los hechos de la operacion que ningun documento declara.
 *
 * Llega la lista completa y reemplaza la anterior, no un hecho a la vez: son
 * cuatro casillas de una misma pregunta, y desmarcar una es tan significativo
 * como marcarla. Un endpoint por hecho obligaria a la pantalla a calcular
 * diferencias para algo que cabe entero en un PUT.
 */
export class GuardarHechosOperativosDto {
  @IsArray()
  @IsIn(
    [
      'TIENE_EMPLEADOS',
      'TIENE_ACTIVOS_FIJOS',
      'TIENE_CREDITO_BANCARIO',
      'MANEJA_CAJA_MENOR',
    ],
    { each: true, message: 'Hecho operativo no reconocido' },
  )
  hechos!: string[];
}

/**
 * La tarifa de ICA de una actividad que se registró sin ella —la lectura del
 * RUT no la trae: la fija el acuerdo del municipio—.
 */
export class TarifaIcaDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  // Por mil: ninguna tarifa municipal se acerca a 30. Un 8000 es alguien que
  // escribió «8.000» queriendo decir 8.
  @Max(30, { message: 'La tarifa de ICA va por mil y ninguna pasa de 30. Si es 8 por mil, escribí 8.' })
  tarifaIcaPorMil!: number;
}
