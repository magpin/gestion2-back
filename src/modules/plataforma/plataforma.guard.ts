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
import { TxService } from '../../common/db/tx.service';

/**
 * Verifica el token de plataforma.
 *
 * Es un guard aparte del de clientes a propósito. Los dos tipos de token se
 * firman con el mismo secreto, así que lo que los separa es el campo `amb`: sin
 * él, un token de cliente serviría para administrar el producto entero.
 *
 * Además de la firma, mira que el administrador siga activo: desactivarlo
 * desde la consola tiene que cortarle la sesión abierta, no esperar a que
 * venza el token.
 */
@Injectable()
export class PlataformaGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENTORNO) private readonly env: Entorno,
    private readonly tx: TxService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
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

    const [admin] = await this.tx.sinContexto((t) =>
      t.query<Array<{ activo: boolean }>>(
        'SELECT activo FROM plataforma_admin WHERE id = $1',
        [payload.sub],
      ),
    );
    if (admin === undefined || !admin.activo) {
      throw new UnauthorizedException('Este administrador está desactivado');
    }

    req.admin = { adminId: payload.sub, email: payload.email };
    return true;
  }
}
