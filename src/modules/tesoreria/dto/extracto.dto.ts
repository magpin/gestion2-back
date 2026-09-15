import { IsIn, IsNumber, IsString, IsUUID, Length, Min } from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** La cabecera: el rango de fechas y los saldos que dice el banco. */
export class CrearExtractoDto {
  @EsFechaCalendario()
  fechaDesde!: string;

  @EsFechaCalendario()
  fechaHasta!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoInicialBanco!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  saldoFinalBanco!: number;
}

export const TIPOS_LINEA_EXTRACTO = ['DEBITO', 'CREDITO'] as const;

/** Un renglón del extracto, digitado a mano. */
export class AgregarLineaExtractoDto {
  @EsFechaCalendario()
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
