import { IsBoolean, IsUUID } from 'class-validator';

export class FijarCuentaAjusteDto {
  @IsUUID()
  cuentaAjusteId!: string;
}

/**
 * Habilita el descubierto para la empresa entera. Va en su propio endpoint y
 * no junto a la cuenta de ajuste: son dos decisiones distintas, de dos
 * momentos distintos, y mezclarlas obligaría a mandar una para cambiar la otra.
 */
export class FijarExistenciaNegativaDto {
  @IsBoolean()
  permite!: boolean;
}
