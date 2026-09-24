import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

/**
 * El tipo de documento ya no se escribe aca: vive en `tipo_documento_identidad`
 * y el servicio valida contra el catalogo. Tenerlo en dos listas hacia que la
 * base aceptara 'TE' y el DTO lo rechazara.
 */
const PATRON_TIPO_DOCUMENTO = /^[A-Z_]{2,20}$/;

/** Codigos de responsabilidad fiscal del anexo tecnico DIAN: O-13, R-99-PN, … */
const PATRON_RESPONSABILIDAD = /^[A-Z]-[0-9]{2}(-[A-Z]{2})?$/;

export class CrearTerceroDto {
  @IsIn(['NATURAL', 'JURIDICA'])
  tipoPersona!: 'NATURAL' | 'JURIDICA';

  @Matches(PATRON_TIPO_DOCUMENTO, { message: 'Tipo de documento invalido' })
  tipoDocumento!: string;

  @IsString()
  @Length(1, 20)
  numeroDocumento!: string;

  /** Obligatorio y verificado cuando el documento es NIT. */
  @IsOptional()
  @Matches(/^[0-9]$/)
  dv?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  razonSocial?: string;

  @IsOptional()
  @IsString()
  primerNombre?: string;

  @IsOptional()
  @IsString()
  segundoNombre?: string;

  @IsOptional()
  @IsString()
  primerApellido?: string;

  @IsOptional()
  @IsString()
  segundoApellido?: string;

  @IsOptional()
  @IsString()
  nombreComercial?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsString()
  direccion?: string;

  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  @IsOptional()
  @IsBoolean()
  esCliente?: boolean;

  @IsOptional()
  @IsBoolean()
  esProveedor?: boolean;

  /** Trabaja para la empresa: responde por una caja. */
  @IsOptional()
  @IsBoolean()
  esEmpleado?: boolean;

  @IsOptional()
  @IsBoolean()
  responsableIva?: boolean;

  @IsOptional()
  @IsBoolean()
  esAgenteRetenedor?: boolean;

  @IsOptional()
  @IsBoolean()
  esAutorretenedor?: boolean;

  @IsOptional()
  @IsBoolean()
  esGranContribuyente?: boolean;

  @IsOptional()
  @IsBoolean()
  regimenSimple?: boolean;

  @IsOptional()
  @IsArray()
  @Matches(PATRON_RESPONSABILIDAD, { each: true })
  responsabilidadesDian?: string[];
}

export class EditarTerceroDto {
  @IsOptional()
  @IsString()
  razonSocial?: string;

  @IsOptional()
  @IsString()
  primerNombre?: string;

  @IsOptional()
  @IsString()
  segundoNombre?: string;

  @IsOptional()
  @IsString()
  primerApellido?: string;

  @IsOptional()
  @IsString()
  segundoApellido?: string;

  @IsOptional()
  @IsString()
  nombreComercial?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsString()
  direccion?: string;

  @IsOptional()
  @Matches(/^[0-9]{5}$/)
  municipioCodigo?: string;

  @IsOptional()
  @IsBoolean()
  esCliente?: boolean;

  @IsOptional()
  @IsBoolean()
  esProveedor?: boolean;

  /** Trabaja para la empresa: responde por una caja. */
  @IsOptional()
  @IsBoolean()
  esEmpleado?: boolean;

  @IsOptional()
  @IsBoolean()
  responsableIva?: boolean;

  @IsOptional()
  @IsBoolean()
  esAgenteRetenedor?: boolean;

  @IsOptional()
  @IsBoolean()
  esAutorretenedor?: boolean;

  @IsOptional()
  @IsBoolean()
  esGranContribuyente?: boolean;

  @IsOptional()
  @IsBoolean()
  regimenSimple?: boolean;

  @IsOptional()
  @IsArray()
  @Matches(PATRON_RESPONSABILIDAD, { each: true })
  responsabilidadesDian?: string[];
}

/** Los booleanos llegan como texto en la query string. */
const aBooleano = ({ value }: { value: unknown }): boolean | undefined =>
  value === undefined ? undefined : value === 'true' || value === true;

export class ListarTercerosDto extends PaginacionDto {
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  esCliente?: boolean;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  esProveedor?: boolean;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  esEmpleado?: boolean;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  incluirInactivos?: boolean;

  /** Solo los desactivados. Manda sobre `incluirInactivos`. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  soloInactivos?: boolean;
}
