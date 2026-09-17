import { IsNumber, IsOptional, IsString, Length } from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Qué día se quiere ver antes de cortarlo. */
export class PrevioCorteDto {
  @EsFechaCalendario()
  fecha!: string;
}

/**
 * Corta un día. Entradas, salidas y saldos los calcula el servicio del libro,
 * no quien llama. `saldoBanco` es lo que muestra el portal del banco, si
 * alguien lo leyó: sin CHECK de signo, porque hay sobregiro.
 */
export class CerrarCorteDto {
  @EsFechaCalendario()
  fecha!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  saldoBanco?: number;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  nota?: string;
}

/** `cuentaBancariaId` va por la ruta: el historial siempre es de UNA cuenta. */
export class ListarCortesDto extends PaginacionDto {}
