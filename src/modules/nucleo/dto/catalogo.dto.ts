import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Los catálogos normativos son de solo lectura, así que acá no hay DTO de
 * escritura: solo la validación de lo que llega por query string.
 */

export class BuscarCiiuDto {
  /** Texto libre. Busca sin tildes ni mayúsculas, en el nombre y en el código. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  @IsOptional()
  @Matches(/^[A-U]$/, {
    message: 'La seccion CIIU es una letra de la A a la U',
  })
  seccion?: string;

  @IsOptional()
  @Matches(/^[0-9]{2}$/, { message: 'La division CIIU tiene 2 digitos' })
  division?: string;

  @IsOptional()
  @Matches(/^[0-9]{3}$/, { message: 'El grupo CIIU tiene 3 digitos' })
  grupo?: string;

  /**
   * 'DANE' son las actividades reales; 'DIAN' son las cinco clasificaciones para
   * personas naturales sin actividad (asalariado, pensionado, rentista). Sin
   * filtro vienen las dos, que es lo que necesita el selector del RUT.
   */
  @IsOptional()
  @IsIn(['DANE', 'DIAN'])
  origen?: 'DANE' | 'DIAN';
}

export class BuscarPucDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  /** 1 clase · 2 grupo · 4 cuenta · 6 subcuenta. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 4, 6])
  nivel?: 1 | 2 | 4 | 6;

  @IsOptional()
  @Matches(/^[0-9]{1,6}$/, {
    message: 'El codigo PUC tiene entre 1 y 6 digitos',
  })
  padre?: string;

  /**
   * Solo las imputables (nivel 6). Es lo que pide un selector de cuenta para
   * asentar: los niveles de agrupación no reciben movimiento.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  soloImputables?: 'true' | 'false';
}

/**
 * Casilla 53 del RUT. Se busca por número y por descripción a la vez: quien
 * tiene el RUT delante escribe "48", y quien no, escribe "ventas".
 */
export class BuscarResponsabilidadRutDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  /**
   * Las suprimidas existen para poder leer un RUT viejo, no para ofrecerlas al
   * llenar uno nuevo. Por eso quedan fuera salvo que se pidan.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  incluirNoVigentes?: 'true' | 'false';
}
