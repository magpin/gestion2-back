import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

const TIPOS_DOCUMENTO = [
  'FACTURA_VENTA',
  'FACTURA_CONTINGENCIA',
  'NOTA_CREDITO',
  'NOTA_DEBITO',
  'DOCUMENTO_SOPORTE',
  'NOTA_AJUSTE_DOC_SOPORTE',
  'NOMINA_ELECTRONICA',
  'POS',
] as const;

export class CrearResolucionDto {
  @IsIn(TIPOS_DOCUMENTO)
  tipoDocumento!: (typeof TIPOS_DOCUMENTO)[number];

  @IsString()
  @Length(1, 30)
  numeroResolucion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 6)
  prefijo?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  rangoDesde!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  rangoHasta!: number;

  @IsDateString()
  fechaResolucion!: string;

  @IsDateString()
  fechaVigenciaDesde!: string;

  @IsDateString()
  fechaVigenciaHasta!: string;

  @IsIn(['HABILITACION', 'PRODUCCION'])
  ambiente!: 'HABILITACION' | 'PRODUCCION';

  /** Se guarda cifrada. Entra en el cálculo del CUFE. */
  @IsOptional()
  @IsString()
  claveTecnica?: string;

  /** Desactiva la resolución activa del mismo tipo y ambiente antes de insertar. */
  @IsOptional()
  @IsBoolean()
  reemplazarActiva?: boolean;
}

/**
 * Credenciales DIAN. Todo lo sensible se guarda cifrado y no vuelve a salir por
 * la API: los endpoints de lectura solo informan si está cargado y cuándo vence.
 */
export class GuardarCredencialDto {
  @IsOptional()
  @IsString()
  softwareId?: string;

  @IsOptional()
  @IsString()
  softwarePin?: string;

  @IsOptional()
  @IsString()
  certificadoClave?: string;

  @IsOptional()
  @IsDateString()
  certificadoVenceEn?: string;

  @IsOptional()
  @IsString()
  proveedorTecnologico?: string;

  @IsOptional()
  @IsString()
  testSetId?: string;
}
