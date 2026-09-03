import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

import type { Ctx, CtxEmpresa, RolCodigo } from '../ctx';

export const CLAVE_PUBLICO = 'es_publico';
export const CLAVE_ROLES = 'roles_requeridos';
export const CLAVE_EXIGE_EMPRESA = 'exige_empresa';

/** Endpoint sin token: login y alta de tenant. Todo lo demás lo exige. */
export const Publico = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CLAVE_PUBLICO, true);

/**
 * Los permisos se suman: basta con tener uno de los roles listados.
 * `DIRECTOR` no es superusuario — si un endpoint es de caja, el director tiene
 * que estar listado explícitamente.
 */
export const Roles = (
  ...roles: RolCodigo[]
): MethodDecorator & ClassDecorator => SetMetadata(CLAVE_ROLES, roles);

/**
 * Exige que el token traiga empresa elegida. Lo aplica todo lo que toca datos
 * contables: sin `empresaId` el contexto de RLS queda vacío y las consultas no
 * devuelven nada, lo que sería un 200 con lista vacía en vez de un error claro.
 */
export const ExigeEmpresa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CLAVE_EXIGE_EMPRESA, true);

/** Inyecta el `Ctx` armado por el guard. */
export const Actor = createParamDecorator(
  (_datos: unknown, contexto: ExecutionContext): Ctx => {
    const req = contexto.switchToHttp().getRequest<Request & { ctx?: Ctx }>();
    if (req.ctx === undefined) {
      throw new Error(
        'No hay Ctx en la peticion: falta el guard de autenticacion',
      );
    }
    return req.ctx;
  },
);

/** Igual que `@Actor()`, pero tipado con empresa garantizada por `@ExigeEmpresa()`. */
export const ActorEmpresa = createParamDecorator(
  (_datos: unknown, contexto: ExecutionContext): CtxEmpresa => {
    const req = contexto.switchToHttp().getRequest<Request & { ctx?: Ctx }>();
    if (req.ctx?.empresaId === undefined) {
      throw new Error('No hay empresa en el Ctx: falta @ExigeEmpresa()');
    }
    return req.ctx as CtxEmpresa;
  },
);
