import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsUUID,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import {
  DENOMINACIONES_COP,
  type TipoDenominacion,
} from '../servicios/caja.reglas';

/** Abre el arqueo del día: `saldo_sistema` lo congela el servicio, no acá. */
export class AbrirArqueoDto {
  @EsFechaCalendario()
  fecha!: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  nota?: string;
}

/** Cuántos billetes o monedas de una denominación se contaron. */
export class DenominacionDto {
  @IsIn(Object.keys(DENOMINACIONES_COP))
  tipo!: TipoDenominacion;

  @IsNumber()
  denominacion!: number;

  @IsInt()
  @Min(0)
  cantidad!: number;
}

/**
 * Cierra el arqueo abierto de esta caja con lo que se contó: el total a secas
 * (`saldoContado`), el conteo billete por billete (`denominaciones`), o los
 * dos —y entonces tienen que coincidir—. La diferencia contra
 * `saldo_sistema` la calcula el servicio, no quien llama. Ver
 * `resolverConteo`.
 */
export class CerrarArqueoDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  saldoContado?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => DenominacionDto)
  denominaciones?: DenominacionDto[];

  @IsOptional()
  @IsString()
  @Length(0, 300)
  nota?: string;

  /**
   * Solo con faltante, y ahí es obligatorio: EMPRESA lo lleva a gasto,
   * RESPONSABLE lo cobra al responsable de la caja. Con sobrante se ignora.
   */
  @IsOptional()
  @IsIn(['EMPRESA', 'RESPONSABLE'])
  tratamientoFaltante?: 'EMPRESA' | 'RESPONSABLE';

  /** A quién se le cobra, si no es el responsable de la caja. */
  @IsOptional()
  @IsUUID()
  responsableTerceroId?: string;
}

/** `cajaId` va por la ruta: el historial siempre es de UNA caja. */
export class ListarArqueosDto extends PaginacionDto {}
