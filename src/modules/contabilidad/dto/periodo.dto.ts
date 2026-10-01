import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class AbrirPeriodoDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  mes!: number;
}

export class ListarPeriodosDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio?: number;
}

/** Cómo se agrupan los meses en la vista del calendario. */
export class ResumenPeriodosDto extends ListarPeriodosDto {
  @IsIn(['MENSUAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'])
  agrupacion!: 'MENSUAL' | 'TRIMESTRAL' | 'SEMESTRAL' | 'ANUAL';
}
