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

/**
 * El saldo con el que arranca una cuenta bancaria recién creada. No
 * genera asiento — mismo motivo que `CargaInicialCajaDto`: la
 * contrapartida es una decisión de migración que un contador valida caso
 * por caso.
 */
export class CargaInicialBancoDto {
  /** La fecha del hecho, no la de digitación. */
  @EsFechaCalendario()
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsString()
  @Length(3, 300)
  concepto!: string;
}

/** `cuentaBancariaId` va por la ruta: el libro siempre es de UNA cuenta. */
export class ListarMovimientosBancoDto extends PaginacionDto {
  /**
   * Solo lo que queda por conciliar: sin cruce y sin el saldo inicial, que no
   * se cruza contra nada. Es lo que necesita la conciliación, y paginar el
   * libro entero le escondía los cheques viejos.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  sinConciliar?: 'true' | 'false';
}

/**
 * Los siete tipos que se registran a mano — todos menos `SALDO_INICIAL`
 * (`registrarSaldoInicial`, sin asiento). `CONSIGNACION`/`NOTA_CREDITO`
 * suman al saldo; `RETIRO`/`NOTA_DEBITO`/`CHEQUE` restan.
 * `TRANSFERENCIA_ENTRANTE`/`TRANSFERENCIA_SALIENTE` también se pueden
 * digitar a mano acá, además de ser los que usa `TesoreriaApi` para un
 * cobro/pago por transferencia (`registrarMovimientoDocumento`).
 */
export const TIPOS_MOVIMIENTO_BANCO_MANUAL = [
  'CONSIGNACION',
  'RETIRO',
  'TRANSFERENCIA_ENTRANTE',
  'TRANSFERENCIA_SALIENTE',
  'NOTA_DEBITO',
  'NOTA_CREDITO',
  'CHEQUE',
] as const;

/**
 * Un movimiento manual, sin factura de por medio. `contraCuentaId` es la
 * otra pata del asiento — quien registra el movimiento la elige, mismo
 * criterio que `IngresoCajaDto`/`EgresoCajaDto`.
 */
export class RegistrarMovimientoBancoDto {
  @IsIn(TIPOS_MOVIMIENTO_BANCO_MANUAL)
  tipo!: (typeof TIPOS_MOVIMIENTO_BANCO_MANUAL)[number];

  @EsFechaCalendario()
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsString()
  @Length(3, 300)
  concepto!: string;

  @IsUUID()
  contraCuentaId!: string;

  /** Si la contracuenta es de ingreso, costo o gasto: dónde. */
  @IsOptional()
  @IsUUID()
  centroCostoId?: string;

  /** Número de cheque, de aprobación o de transacción: con él cruza la conciliación. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  referencia?: string;
}
