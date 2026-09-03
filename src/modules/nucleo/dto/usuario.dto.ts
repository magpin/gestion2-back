import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';

import { ROLES, type RolCodigo } from '../../../common/ctx';

const ROLES_EMPRESA = ROLES.filter((r) => r !== 'ADMIN_TENANT');

export class AsignarRolDto {
  @IsUUID()
  empresaId!: string;

  @IsIn(ROLES_EMPRESA)
  rol!: RolCodigo;
}

export class CrearUsuarioDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(3, 200)
  nombreCompleto!: string;

  /**
   * Doce caracteres como mínimo. La contraseña se hashea con argon2id y no se
   * guarda ni se registra en ningún log.
   */
  @IsString()
  @Length(12, 200)
  password!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AsignarRolDto)
  accesos?: AsignarRolDto[];

  @IsOptional()
  @IsBoolean()
  esAdminTenant?: boolean;
}

export class EditarUsuarioDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  nombreCompleto?: string;

  @IsOptional()
  @IsString()
  @Length(12, 200)
  password?: string;
}

export class RevocarRolDto {
  @IsUUID()
  empresaId!: string;

  @IsIn(ROLES_EMPRESA)
  rol!: RolCodigo;
}
