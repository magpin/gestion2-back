import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

/** La cabecera: el rango de fechas y los saldos que dice el banco. */
export class CrearExtractoDto {
  @IsISO8601({ strict: true })
  fechaDesde!: string;

  @IsISO8601({ strict: true })
  fechaHasta!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoInicialBanco!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoFinalBanco!: number;
}

export const TIPOS_LINEA_EXTRACTO = ['DEBITO', 'CREDITO'] as const;

/** Un renglón del extracto, digitado a mano. */
export class AgregarLineaExtractoDto {
  @IsISO8601({ strict: true })
  fecha!: string;

  @IsString()
  @Length(3, 300)
  descripcion!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsIn(TIPOS_LINEA_EXTRACTO)
  tipo!: (typeof TIPOS_LINEA_EXTRACTO)[number];
}

/** Aparea a mano una línea suelta con un movimiento suelto — lo que el automático dejó sin tocar. */
export class ConciliarManualDto {
  @IsUUID()
  lineaId!: string;

  @IsUUID()
  movimientoId!: string;
}

/** `cuentaBancariaId` va por la ruta: el historial siempre es de UNA cuenta. */
export class ListarExtractosDto extends PaginacionDto {}
