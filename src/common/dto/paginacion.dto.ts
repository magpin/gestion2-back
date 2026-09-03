import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginacionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina = 1;

  /** Tope duro: sin él, un cliente puede pedir la tabla entera de terceros. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  tamano = 50;

  @IsOptional()
  @IsString()
  q?: string;

  get salto(): number {
    return (this.pagina - 1) * this.tamano;
  }
}

export interface Pagina<T> {
  datos: T[];
  pagina: number;
  tamano: number;
  total: number;
}

export function armarPagina<T>(
  datos: T[],
  total: number,
  p: PaginacionDto,
): Pagina<T> {
  return { datos, total, pagina: p.pagina, tamano: p.tamano };
}
