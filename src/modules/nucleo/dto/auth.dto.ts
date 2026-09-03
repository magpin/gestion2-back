import { IsEmail, IsString, IsUUID, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}

export class ElegirEmpresaDto {
  @IsUUID()
  empresaId!: string;
}
