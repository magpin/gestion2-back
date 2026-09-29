import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

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

  @IsUUID()
  conceptoId!: string;

  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsString()
  @Length(3, 300)
  detalle!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
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
