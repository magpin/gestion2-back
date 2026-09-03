import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** El código de una cuenta de empresa: dígitos, hasta 20. */
const CODIGO = /^[0-9]{1,20}$/;

export class CrearCuentaEmpresaDto {
  @Matches(CODIGO, {
    message: 'El codigo de la cuenta son solo digitos, hasta 20',
  })
  codigo!: string;

  @IsString()
  @Length(2, 200)
  nombre!: string;

  /**
   * Ancestro en el Decreto 2650. Opcional: si no llega, el servicio lo deduce
   * tomando el prefijo más largo del código que exista en `cuenta_puc`. Mandarlo
   * a mano sirve para anclar más arriba a propósito.
   */
  @IsOptional()
  @Matches(/^[0-9]{1,6}$/, {
    message: 'El codigo PUC tiene entre 1 y 6 digitos',
  })
  codigoPuc?: string;

  /** Si no llega, se hereda de la cuenta del catálogo. */
  @IsOptional()
  @IsIn(['DEBITO', 'CREDITO'])
  naturaleza?: 'DEBITO' | 'CREDITO';

  @IsOptional()
  @IsBoolean()
  esAuxiliar?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeCentroCosto?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeBaseGravable?: boolean;
}

/**
 * El código no se edita: es la identidad de la cuenta y ya está escrito en los
 * asientos. Para renumerar se crea otra y se desactiva esta.
 */
export class EditarCuentaEmpresaDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nombre?: string;

  @IsOptional()
  @IsIn(['DEBITO', 'CREDITO'])
  naturaleza?: 'DEBITO' | 'CREDITO';

  @IsOptional()
  @IsBoolean()
  esAuxiliar?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeCentroCosto?: boolean;

  @IsOptional()
  @IsBoolean()
  exigeBaseGravable?: boolean;
}

export class ListarCuentasEmpresaDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  soloAuxiliares?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  incluirInactivas?: 'true' | 'false';
}

/** Lo que el usuario confirmó de la sugerencia. Solo viajan los códigos aceptados. */
export class AplicarSugerenciaDto {
  @IsString({ each: true })
  @Matches(CODIGO, { each: true, message: 'Codigo de cuenta invalido' })
  codigos!: string[];
}

export class CrearCentroCostoDto {
  @IsString()
  @Length(1, 20)
  codigo!: string;

  @IsString()
  @Length(2, 120)
  nombre!: string;
}

export class EditarCentroCostoDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  nombre?: string;
}
