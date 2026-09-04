import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/** Las cinco clases del catálogo. `0021` las sostiene con un CHECK. */
export const NATURALEZAS = [
  'DIARIO',
  'INGRESO',
  'EGRESO',
  'APERTURA',
  'CIERRE',
] as const;

export class CrearComprobanteDto {
  @Matches(/^[A-Za-z0-9]{1,6}$/, {
    message: 'El codigo son hasta seis letras o digitos, sin espacios',
  })
  codigo!: string;

  @IsString()
  @Length(2, 120)
  nombre!: string;

  @IsIn(NATURALEZAS)
  naturaleza!: (typeof NATURALEZAS)[number];

  @Matches(/^[A-Za-z0-9]{1,4}$/, {
    message: 'El prefijo son hasta cuatro letras o digitos, sin espacios',
  })
  prefijo!: string;
}

/**
 * Solo el nombre.
 *
 * El prefijo y la naturaleza no se editan: cambiar el prefijo dejaria los
 * asientos ya numerados con uno que la tabla ya no reconoce, y cambiar la
 * naturaleza convertiria comprobantes de diario en asientos de apertura sin que
 * el libro lo refleje.
 */
export class EditarComprobanteDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  nombre?: string;
}
