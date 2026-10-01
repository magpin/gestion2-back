import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import {
  CLASES_ACTIVO,
  PLANTILLAS,
  RAMOS_SEGURO,
  type ClaseActivo,
  type Plantilla,
  type RamoSeguro,
} from '../servicios/plantillas.reglas';

/** Los datos de la plantilla. Cada una usa los suyos; los demás sobran. */
export class DatosPlantillaDto {
  @IsOptional()
  @IsIn(Object.keys(CLASES_ACTIVO))
  clase?: ClaseActivo;

  @IsOptional()
  @IsIn(Object.keys(RAMOS_SEGURO))
  ramo?: RamoSeguro;

  /** Depreciación: el costo del activo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  costo?: number;

  /** Depreciación y seguros: los meses de vida útil o de vigencia. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  meses?: number;

  /** Prima: los salarios del mes. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  salarios?: number;

  /** Seguros: el valor de la póliza. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  valor?: number;
}

/** Qué propone María: por plantilla, o reconociéndola en lo que se escribió. */
export class PropuestaDto {
  @IsOptional()
  @IsIn(PLANTILLAS)
  plantilla?: Plantilla;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  texto?: string;

  /** La fecha del comprobante: da el mes de la glosa. */
  @EsFechaCalendario()
  fecha!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DatosPlantillaDto)
  datos?: DatosPlantillaDto;
}

const TIPOS_SOPORTE = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export class FirmarSoporteDto {
  @IsIn(TIPOS_SOPORTE)
  tipoMime!: (typeof TIPOS_SOPORTE)[number];
}

/** El soporte ya subido: la llave que devolvió la firma y el nombre del archivo. */
export class SoporteAsientoDto {
  @IsString()
  @Length(10, 300)
  clave!: string;

  @IsString()
  @Length(1, 200)
  nombre!: string;
}
