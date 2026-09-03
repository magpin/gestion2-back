import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Ctx, RolCodigo } from '../ctx';
import { CLAVE_PUBLICO, CLAVE_ROLES } from './decoradores';

/**
 * Los permisos se suman: basta con tener uno de los roles pedidos.
 *
 * Corre después de `JwtGuard`, que es quien deja el `Ctx` en la petición.
 *
 * Las autorizaciones del negocio no se resuelven acá. Aprobar una venta bajo el
 * precio piso es un dato —queda firmado en la fila—, no un permiso de endpoint.
 * Un guard diría "no puedes"; el negocio dice "puedes, con la firma de quien
 * responde".
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const publico = this.reflector.getAllAndOverride<boolean>(CLAVE_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (publico === true) {
      return true;
    }

    const requeridos = this.reflector.getAllAndOverride<RolCodigo[]>(
      CLAVE_ROLES,
      [contexto.getHandler(), contexto.getClass()],
    );
    if (requeridos === undefined || requeridos.length === 0) {
      return true;
    }

    const req = contexto.switchToHttp().getRequest<Request & { ctx?: Ctx }>();
    const roles = req.ctx?.roles ?? [];

    if (!requeridos.some((rol) => roles.includes(rol))) {
      throw new ForbiddenException(
        `Se requiere uno de estos roles: ${requeridos.join(', ')}`,
      );
    }

    return true;
  }
}
