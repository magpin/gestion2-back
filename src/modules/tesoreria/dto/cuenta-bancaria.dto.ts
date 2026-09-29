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
