import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

/**
 * Dar de alta a un cliente son dos datos: correo y contraseña.
 *
 * Nada de la empresa se pregunta acá. El NIT, el marco NIIF y la fecha de inicio
 * de operaciones los sabe el contador del cliente, no quien vende el sistema, y
 * pedirlos en la venta obliga a adivinarlos o a dejarlos mal puestos. El director
 * crea su empresa cuando entra.
 *
 * El nombre y el identificador de la cuenta se derivan del correo: son etiquetas
 * internas que el propio cliente cambia después, y pedirlas sería inventar
 * trabajo para quien vende.
 */
export class CrearCuentaDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(12, 200)
  password!: string;

  /** Opcional: si no viene, se usa la parte del correo antes de la arroba. */
  @IsOptional()
  @IsString()
  @Length(3, 200)
  nombreAdministrador?: string;

  @IsOptional()
  @IsIn(['BASICO', 'PROFESIONAL', 'CONTADOR', 'EMPRESARIAL'])
  plan?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxEmpresas?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUsuarios?: number;
}

export class EditarCuentaDto {
  @IsOptional()
  @IsString()
  @Length(3, 120)
  nombre?: string;

  @IsOptional()
  @IsIn(['BASICO', 'PROFESIONAL', 'CONTADOR', 'EMPRESARIAL'])
  plan?: string;

  @IsOptional()
  @IsIn(['ACTIVO', 'SUSPENDIDO', 'MOROSO', 'CANCELADO'])
  estado?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxEmpresas?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUsuarios?: number;
}

/**
 * Crear una empresa dentro de una cuenta existente.
 *
 * No es parte del alta: es una salida de soporte para cuando el cliente no puede
 * hacerlo solo. El camino normal es que el director la cree desde su asistente.
 */
export class CrearEmpresaEnCuentaDto {
  @IsIn(['JURIDICA', 'NATURAL'])
  tipoPersona!: 'JURIDICA' | 'NATURAL';

  @IsString()
  @Length(3, 200)
  razonSocial!: string;

  @IsOptional()
  @IsString()
  nombreComercial?: string;

  @Matches(/^[0-9]{5,15}$/, {
    message: 'El NIT debe tener entre 5 y 15 digitos',
  })
  nit!: string;

  /** Se verifica contra `fn_dv_nit` en la base: un DV que no cuadra no entra. */
  @Matches(/^[0-9]$/)
  dv!: string;

  @IsIn(['COMERCIO', 'SERVICIOS', 'MANUFACTURA', 'MIXTO'])
  /**
   * A que se dedica, en grueso. Puede ser mas de uno, y puede no venir ninguno:
   * quien vende el sistema no siempre lo sabe, y adivinarlo es peor que dejarlo
   * en blanco para que el director lo marque.
   */
  @IsOptional()
  @IsArray()
  @IsIn(['COMERCIO', 'SERVICIOS', 'MANUFACTURA'], { each: true })
  sectores?: string[];

  @IsIn(['GRUPO_1', 'GRUPO_2', 'GRUPO_3'])
  grupoNiif!: string;

  @IsDateString()
  fechaInicioOperaciones!: string;
}

export class CrearUsuarioEnCuentaDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(3, 200)
  nombreCompleto!: string;

  @IsString()
  @Length(12, 200)
  password!: string;

  @IsOptional()
  @IsBoolean()
  esAdminCuenta?: boolean;

  /** Si viene con `rol`, el usuario nace con acceso a esa empresa. */
  @IsOptional()
  @IsUUID()
  empresaId?: string;

  @IsOptional()
  @IsIn([
    'DIRECTOR',
    'CONTADOR',
    'VENTAS',
    'COMPRAS',
    'INVENTARIO',
    'CAJA',
    'CONSULTA',
  ])
  rol?: string;
}
