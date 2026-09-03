import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';

import { ENTORNO, type Entorno } from '../../config/env';
import { AMBITO_PLATAFORMA, type CtxPlataforma } from '../../common/ctx';

/**
 * Verifica el token de plataforma.
 *
 * Es un guard aparte del de clientes a propósito. Los dos tipos de token se
 * firman con el mismo secreto, así que lo que los separa es el campo `amb`: sin
 * él, un token de cliente serviría para administrar el producto entero.
 */
@Injectable()
export class PlataformaGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENTORNO) private readonly env: Entorno,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto
      .switchToHttp()
      .getRequest<Request & { admin?: CtxPlataforma }>();
    const cabecera = req.headers.authorization;

    if (cabecera === undefined || !cabecera.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token');
    }

    let payload: { sub: string; email: string; amb?: string };
    try {
      payload = this.jwt.verify(cabecera.slice('Bearer '.length), {
        secret: this.env.jwt.secreto,
      });
    } catch {
      throw new UnauthorizedException('Token invalido o vencido');
    }

    if (payload.amb !== AMBITO_PLATAFORMA) {
      throw new UnauthorizedException(
        'Este token no sirve para administrar la plataforma',
      );
    }

    req.admin = { adminId: payload.sub, email: payload.email };
    return true;
  }
}
