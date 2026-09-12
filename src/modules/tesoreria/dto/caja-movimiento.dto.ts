import {
  IsISO8601,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

/**
 * El saldo con el que arranca una caja recién creada. No genera asiento —
 * mismo motivo que `CargaInicialDto` del kardex: la contrapartida (aportes,
 * saldo migrado del sistema anterior) la decide un contador, no una regla
 * que este módulo pueda adivinar.
 */
export class CargaInicialCajaDto {
  /** La fecha del hecho, no la de digitación. */
  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsString()
  @Length(3, 300)
  concepto!: string;
}

/** `cajaId` va por la ruta, no por acá: el libro siempre es de UNA caja. */
export class ListarMovimientosCajaDto extends PaginacionDto {}

/**
 * Un ingreso o egreso manual, sin factura de por medio (un vendedor compra
 * algo con la caja menor, un cliente paga en efectivo algo que no pasó por
 * `Ventas`). `contraCuentaId` es la otra pata del asiento: la cuenta que se
 * acredita en un ingreso, o se debita en un egreso — quien registra el
 * movimiento la elige, porque acá no hay un documento que ya la sepa.
 */
export class IngresoCajaDto {
  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;

  @IsString()
  @Length(3, 300)
  concepto!: string;

  @IsUUID()
  contraCuentaId!: string;
}

/** Misma forma que el ingreso: fecha, valor, concepto, la cuenta contraria. */
export class EgresoCajaDto extends IngresoCajaDto {}
