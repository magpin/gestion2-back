import { IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Abre el arqueo del día: `saldo_sistema` lo congela el servicio, no acá. */
export class AbrirArqueoDto {
  @EsFechaCalendario()
  fecha!: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  nota?: string;
}

/**
 * Cierra el arqueo abierto de esta caja. `saldoContado` es lo que la
 * persona contó a mano — la diferencia contra `saldo_sistema` la calcula
 * el servicio, no quien llama.
 */
export class CerrarArqueoDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  saldoContado!: number;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  nota?: string;
}

/** `cajaId` va por la ruta: el historial siempre es de UNA caja. */
export class ListarArqueosDto extends PaginacionDto {}
