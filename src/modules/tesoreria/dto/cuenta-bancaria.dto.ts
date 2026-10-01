import { IsIn, IsString, IsUUID, Length } from 'class-validator';

export const TIPOS_CUENTA_BANCARIA = [
  'AHORROS',
  'CORRIENTE',
  'BILLETERA',
] as const;

export class CrearCuentaBancariaDto {
  @IsString()
  @Length(2, 100)
  banco!: string;

  @IsString()
  @Length(1, 40)
  numeroCuenta!: string;

  @IsIn(TIPOS_CUENTA_BANCARIA)
  tipoCuenta!: (typeof TIPOS_CUENTA_BANCARIA)[number];

  /**
   * El auxiliar del plan donde vive esta cuenta bancaria. No se edita
   * después de creada: cambiarla dejaría el libro viejo apuntando a una
   * cuenta que esta cuenta bancaria ya no dice usar — mismo criterio que
   * `cuentaId` en `CrearCajaDto`.
   */
  @IsUUID()
  cuentaId!: string;
}

/**
 * Una cuenta bancaria con su auxiliar, de una vez: el banco, el número y el
 * tipo. La cuenta contable la crea el sistema bajo 111005 («Bancos -
 * Bancolombia ···1234»); nadie tiene que ir antes al plan de cuentas.
 */
export class CrearCuentaBancariaConAuxiliarDto {
  @IsString()
  @Length(2, 100)
  banco!: string;

  @IsString()
  @Length(1, 40)
  numeroCuenta!: string;

  @IsIn(TIPOS_CUENTA_BANCARIA)
  tipoCuenta!: (typeof TIPOS_CUENTA_BANCARIA)[number];
}
