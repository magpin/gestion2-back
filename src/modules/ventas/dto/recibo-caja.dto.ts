import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import { MES } from '../../../common/resumen-medio';
import { MEDIOS_PAGO, type MedioPago } from './venta.dto';

/** Lo que el recibo le abona a una factura. */
export class AplicacionReciboDto {
  @IsUUID()
  facturaId!: string;

  /** En plata. Cero si el renglón es solo el descuento. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  valor!: number;

  /** Descuento por pronto pago que se le concede: la salda sin que entre plata. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  descuento?: number;
}

/**
 * Un recibo de caja: un cliente, una fecha, por dónde entra la plata y cuánto
 * se le abona a cada factura. Un solo medio por recibo: si el cliente pagó una
 * parte en efectivo y otra por transferencia, son dos recibos —dos papeles que
 * el cliente puede pedir por separado—.
 */
export class CrearReciboCajaDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsIn(MEDIOS_PAGO)
  medio!: MedioPago;

  @ValidateIf((o: CrearReciboCajaDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: CrearReciboCajaDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  /** Puede ir vacío si el recibo es solo un anticipo. */
  @ValidateNested({ each: true })
  @Type(() => AplicacionReciboDto)
  @ArrayMaxSize(100)
  aplicaciones!: AplicacionReciboDto[];

  /** Lo que el cliente deja por adelantado o paga de más: queda como anticipo suyo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  anticipo?: number;

  /** Lo que se quedó el datáfono o la pasarela: sale del mismo medio. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  comision?: number;
}

export class AnularReciboCajaDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export class ListarRecibosCajaDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;

  /** «2026-09»: los del mes. Sin mes, los últimos 200. */
  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes?: string;
}

/** Aplicar un anticipo o un saldo a favor del cliente a una factura suya. */
export class CrearCruceCarteraDto {
  @IsIn(['ANTICIPO', 'SALDO_A_FAVOR'])
  tipo!: 'ANTICIPO' | 'SALDO_A_FAVOR';

  /** El movimiento del anticipo, o la factura con saldo a favor. */
  @IsUUID()
  origenId!: string;

  @IsUUID()
  destinoFacturaId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @EsFechaCalendario()
  fecha!: string;
}
