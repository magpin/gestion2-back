import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { Actor, Publico } from '../../../common/auth/decoradores';
import type { Ctx } from '../../../common/ctx';
import { ElegirEmpresaDto, LoginDto } from '../dto/auth.dto';
import { AutenticacionService } from '../servicios/autenticacion.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AutenticacionService) {}

  /**
   * Devuelve un token de sesión y la lista de empresas accesibles. Todavía no
   * sirve para operar: hay que elegir una empresa.
   */
  @Publico()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Cambia el token de sesión por uno de trabajo, con empresa y roles dentro. */
  @Post('empresa')
  @HttpCode(HttpStatus.OK)
  elegirEmpresa(@Actor() ctx: Ctx, @Body() dto: ElegirEmpresaDto) {
    return this.auth.elegirEmpresa(ctx, dto.empresaId);
  }

  /** Qué dice el token que se está usando. Sirve para depurar permisos. */
  @Get('yo')
  yo(@Actor() ctx: Ctx) {
    return {
      usuarioId: ctx.usuarioId,
      tenantId: ctx.tenantId,
      empresaId: ctx.empresaId ?? null,
      roles: ctx.roles,
    };
  }

  /** Las empresas a las que el usuario puede entrar, con sus roles en cada una. */
  @Get('empresas')
  empresas(@Actor() ctx: Ctx) {
    return this.auth.empresasDe(ctx);
  }
}
