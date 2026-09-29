import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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

/** Lo que el comprobante le paga a una compra. */
export class AplicacionPagoDto {
  @IsUUID()
  compraId!: string;

  /** En plata. Cero si el renglón es solo el descuento. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  valor!: number;

  /** El descuento por pronto pago que concede el proveedor. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  descuento?: number;
}

/**
 * Un comprobante de egreso: un proveedor, una fecha, de dónde sale la plata,
 * cuánto se le paga a cada compra y, si hay, el anticipo que se le entrega.
 */
export class CrearComprobanteEgresoDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsIn(['CAJA', 'BANCO'])
  medio!: 'CAJA' | 'BANCO';

  @ValidateIf((o: CrearComprobanteEgresoDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: CrearComprobanteEgresoDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @ValidateNested({ each: true })
  @Type(() => AplicacionPagoDto)
  @ArrayMaxSize(100)
  aplicaciones!: AplicacionPagoDto[];

  /** El anticipo en bruto; la retención la calcula el motor. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  anticipo?: number;

  /** El concepto de retención del anticipo, si el motor lo pide. */
  @IsOptional()
  @IsString()
  @Length(2, 60)
  conceptoRetencionAnticipo?: string;
}

export class AnularPagoDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export class FiltroTerceroDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;
}

export class ProponerRetencionAnticipoDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  base!: number;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  conceptoCodigo?: string;
}

export class CrearCrucePagoDto {
  /** El movimiento del anticipo. */
  @IsUUID()
  origenId!: string;

  @IsUUID()
  destinoCompraId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @EsFechaCalendario()
  fecha!: string;
}

export class CrearPagoProgramadoDto {
  @IsString()
  @Length(3, 200)
  descripcion!: string;

  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsOptional()
  @IsUUID()
  compraId?: string;

  @IsOptional()
  @IsUUID()
  conceptoId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @EsFechaCalendario()
  fecha!: string;

  @IsIn(['UNA_VEZ', 'QUINCENAL', 'MENSUAL'])
  recurrencia!: 'UNA_VEZ' | 'QUINCENAL' | 'MENSUAL';

  /** De qué banco va a salir: para proyectar cómo queda cada cuenta. */
  @IsOptional()
  @IsUUID()
  cuentaBancariaId?: string;
}

export class MarcarPagadoDto {
  @IsOptional()
  @IsUUID()
  comprobanteId?: string;

  @IsOptional()
  @IsUUID()
  movimientoId?: string;
}

export class ListarProgramadosDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  todos?: 'true' | 'false';
}
