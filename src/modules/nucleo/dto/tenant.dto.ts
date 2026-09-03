import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CrearTenantDto {
  @IsString()
  @Length(3, 120)
  nombre!: string;

  @Matches(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, {
    message:
      'El slug va en minusculas, con numeros y guiones, entre 3 y 40 caracteres',
  })
  slug!: string;

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

  // Primer usuario de la cuenta. Queda como ADMIN_TENANT.
  @IsEmail()
  email!: string;

  @IsString()
  @Length(3, 200)
  nombreAdministrador!: string;

  @IsString()
  @Length(12, 200)
  password!: string;
}
