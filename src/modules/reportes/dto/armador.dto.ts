import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

import { ORIGENES, type ClaveOrigen } from '../reglas/catalogo';

/**
 * La definición viaja como objeto y **se valida contra el catálogo**, no acá:
 * `reglas/armador.ts` sabe qué columnas tiene cada origen y qué filtros admite
 * cada una, y decirlo dos veces —una en decoradores y otra en el catálogo— es
 * cómo terminan diciendo cosas distintas.
 */
export class CorrerArmadorDto {
  @IsObject()
  definicion!: Record<string, unknown>;

  /** Si se corre un reporte guardado: la corrida queda anotada a su nombre. */
  @IsOptional()
  @IsUUID()
  guardadoId?: string;

  /** El título del Excel. Sin él, el nombre del origen. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  nombre?: string;
}

export class GuardarReporteDto {
  @IsString()
  @Length(1, 120, { message: 'El nombre va de 1 a 120 caracteres.' })
  nombre!: string;

  @IsObject()
  definicion!: Record<string, unknown>;
}

export class ActualizarReporteDto {
  @IsOptional()
  @IsString()
  @Length(1, 120, { message: 'El nombre va de 1 a 120 caracteres.' })
  nombre?: string;

  @IsOptional()
  @IsObject()
  definicion?: Record<string, unknown>;
}

export class ValoresColumnaDto {
  @IsIn(Object.keys(ORIGENES))
  origen!: ClaveOrigen;

  @IsString()
  @Length(1, 60)
  columna!: string;
}
