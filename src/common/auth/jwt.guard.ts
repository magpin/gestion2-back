import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Ctx } from '../ctx';
import { CLAVE_EXIGE_EMPRESA, CLAVE_PUBLICO } from './decoradores';
import { TokenService } from './token.service';

/**
 * Verifica la firma del token y arma el `Ctx`. **No toca la base**: todo lo que
 * necesita viaja firmado. Un guard que consultara la base agregaría una consulta
 * por petición y no mejoraría nada — el token ya es la prueba.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    const publico = this.reflector.getAllAndOverride<boolean>(CLAVE_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (publico === true) {
      return true;
    }

    const req = contexto.switchToHttp().getRequest<Request & { ctx?: Ctx }>();
    const cabecera = req.headers.authorization;
    if (cabecera === undefined || !cabecera.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token');
    }

    let ctx: Ctx;
    try {
      ctx = this.tokens.verificar(cabecera.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Token invalido o vencido');
    }

    const exigeEmpresa = this.reflector.getAllAndOverride<boolean>(
      CLAVE_EXIGE_EMPRESA,
      [contexto.getHandler(), contexto.getClass()],
    );
    if (exigeEmpresa === true && ctx.empresaId === undefined) {
      throw new ForbiddenException('Elegir una empresa antes de operar');
    }

    req.ctx = ctx;
    return true;
  }
}
