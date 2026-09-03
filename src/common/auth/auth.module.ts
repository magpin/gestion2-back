import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { CifradoService } from '../cripto/cifrado.service';
import { PasswordService } from '../cripto/password.service';
import { JwtGuard } from './jwt.guard';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';

/**
 * Autenticación y criptografía. No conoce la base ni ningún módulo de negocio:
 * firma, verifica, cifra y hashea. Quién es cada quien lo resuelve `nucleo`.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    TokenService,
    CifradoService,
    PasswordService,
    JwtGuard,
    RolesGuard,
  ],
  exports: [
    TokenService,
    CifradoService,
    PasswordService,
    JwtGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
