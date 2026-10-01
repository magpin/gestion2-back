import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Una línea de un movimiento con varios conceptos (PC14): la cuota de un préstamo, capital e intereses. */
export class LineaConceptoDto {
  @IsUUID()
  conceptoId!: string;

  /** El centro de costo de esta línea, si es distinto al del movimiento. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;

  /** O repartirla entre varios centros por porcentajes (fase 8). */
  @IsOptional()
  @IsUUID()
  repartoId?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

/**
 * Lo que nos retuvo quien nos pagó (PC17): el banco sobre los intereses, un
 * cliente sobre un ingreso. Solo en una entrada; va a 135515, 135517 o 135518.
 */
export class RetencionSufridaDto {
  @IsIn(['RENTA', 'IVA', 'ICA'])
  tipo!: 'RENTA' | 'IVA' | 'ICA';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

/**
 * Un ingreso o un egreso sin factura, a mano: se elige un concepto, nunca
 * una cuenta. Ingresos → Cobros «Ingresos sin factura»; Egresos → Pagos «Sin
 * factura».
 */
export class CrearMovimientoConceptoDto {
  @IsIn(['ENTRADA', 'SALIDA'])
  direccion!: 'ENTRADA' | 'SALIDA';

  @IsIn(['CAJA', 'BANCO'])
  medio!: 'CAJA' | 'BANCO';

  @ValidateIf((o: CrearMovimientoConceptoDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: CrearMovimientoConceptoDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @EsFechaCalendario()
  fecha!: string;

  /** Con una sola línea. Con varias, van en `lineas`. */
  @ValidateIf((o: CrearMovimientoConceptoDto) => o.lineas === undefined)
  @IsUUID()
  conceptoId?: string;

  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsString()
  @Length(3, 300)
  detalle!: string;

  @ValidateIf((o: CrearMovimientoConceptoDto) => o.lineas === undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LineaConceptoDto)
  lineas?: LineaConceptoDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => RetencionSufridaDto)
  retencion?: RetencionSufridaDto;

  /** Dónde se gastó o se ganó; sin él, el que proponga el sistema. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;
}

export class AnularMovimientoConceptoDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export class ListarMovimientosConceptoDto {
  @IsOptional()
  @IsIn(['ENTRADA', 'SALIDA'])
  direccion?: 'ENTRADA' | 'SALIDA';

  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsOptional()
  @IsIn(['MANUAL', 'RECIBO_CAJA', 'COMPROBANTE_EGRESO', 'GMF'])
  origen?: 'MANUAL' | 'RECIBO_CAJA' | 'COMPROBANTE_EGRESO' | 'GMF';
}

export class GmfPrevistoDto {
  @IsUUID()
  cuentaBancariaId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  valor!: number;
}
