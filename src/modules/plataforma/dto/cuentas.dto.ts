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

const PLANES = ['BASICO', 'PROFESIONAL', 'CONTADOR', 'EMPRESARIAL'];

/**
 * Dar de alta a un cliente: su nombre, su administrador y el plan.
 *
 * Nada de la empresa se pregunta acá. El NIT, el marco NIIF y la fecha de inicio
 * de operaciones los sabe el contador del cliente, no quien vende el sistema, y
 * pedirlos en la venta obliga a adivinarlos o a dejarlos mal puestos. El director
 * crea su empresa cuando entra.
 */
export class CrearCuentaDto {
  @IsEmail()
  email!: string;

  /**
   * Opcional: si no viene, se genera una para dictar (`Hq7r-T4kw-9vXz`) y se
   * devuelve una sola vez en la respuesta.
   */
  @IsOptional()
  @IsString()
  @Length(12, 200)
  password?: string;

  /** El nombre del cliente. Si no viene, el del administrador. */
  @IsOptional()
  @IsString()
  @Length(3, 120)
  nombreCuenta?: string;

  /** Opcional: si no viene, se usa la parte del correo antes de la arroba. */
  @IsOptional()
  @IsString()
  @Length(3, 200)
  nombreAdministrador?: string;

  @IsOptional()
  @IsIn(PLANES)
  plan?: string;

  /** Si no vienen, los del plan en el catálogo. */
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
 * Cambiar de plan trae los cupos del plan nuevo. Si la cuenta ya usa más de
 * lo que el plan permite, se rechaza con el detalle, salvo que quien cambia
 * lo acepte: lo que ya existe sigue, pero no se puede crear más.
 */
export class CambiarPlanDto {
  @IsIn(PLANES)
  plan!: string;

  @IsOptional()
  @IsBoolean()
  aceptarExceso?: boolean;
}

/** Suspender o cancelar pide motivo: es lo que se lee después en la bitácora. */
export class CambiarEstadoDto {
  @IsIn(['ACTIVO', 'SUSPENDIDO', 'MOROSO', 'CANCELADO'])
  estado!: string;

  @IsOptional()
  @IsString()
  @Length(3, 300)
  motivo?: string;
}

export class AjustarCuposDto {
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

export class RenombrarCuentaDto {
  @IsString()
  @Length(3, 120)
  nombre!: string;
}

/** Los cupos con los que nace una cuenta de ese plan. */
export class EditarPlanDto {
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

  /** Opcional: si no viene, se genera una para dictar y se devuelve una vez. */
  @IsOptional()
  @IsString()
  @Length(12, 200)
  password?: string;

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
