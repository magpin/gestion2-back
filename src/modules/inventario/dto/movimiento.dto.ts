import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class CargaInicialDto {
  /** La fecha del hecho, no la de digitación. */
  @EsFechaCalendario()
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costoUnitario!: number;

  @IsString()
  @Length(3, 300)
  motivo!: string;
}

/** Misma forma que la carga inicial: fecha, cantidad, costo, motivo. */
export class EntradaAjusteDto extends CargaInicialDto {
  /** Dónde va la merma o el sobrante; sin él, el centro por defecto. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

export class SalidaAjusteDto {
  @EsFechaCalendario()
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /** No pide costo: una salida se valora al promedio vigente, no a uno nuevo. */
  @IsString()
  @Length(3, 300)
  motivo!: string;

  /**
   * Qué pasó con lo que falta: EMPRESA lo lleva a gasto (merma, daño),
   * RESPONSABLE se lo cobra a una persona. Obligatorio: lo sabe quien contó la
   * bodega, no el sistema.
   */
  @IsIn(['EMPRESA', 'RESPONSABLE'])
  tratamientoFaltante!: 'EMPRESA' | 'RESPONSABLE';

  /** A quién se le cobra. Obligatorio con RESPONSABLE. */
  @IsOptional()
  @IsUUID()
  responsableTerceroId?: string;

  /** Dónde va la merma o el sobrante; sin él, el centro por defecto. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

export class FiltroMovimientosDto extends PaginacionDto {
  @IsOptional()
  @IsUUID()
  productoId?: string;
}
