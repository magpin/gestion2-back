import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Ctx, RolCodigo } from '../ctx';
import { CLAVE_PUBLICO, CLAVE_ROLES } from './decoradores';
import { RolesGuard } from './roles.guard';

function contextoFalso(ctx?: Ctx) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ctx }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

function reflectorCon(valores: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (clave: string) => valores[clave],
  } as unknown as Reflector;
}

const ctxCon = (...roles: RolCodigo[]): Ctx => ({
  tenantId: 't',
  usuarioId: 'u',
  empresaId: 'e',
  roles,
});

describe('RolesGuard', () => {
  it('deja pasar un endpoint publico sin mirar roles', () => {
    const guard = new RolesGuard(reflectorCon({ [CLAVE_PUBLICO]: true }));
    expect(guard.canActivate(contextoFalso())).toBe(true);
  });

  it('deja pasar cuando el endpoint no pide ningun rol', () => {
    const guard = new RolesGuard(reflectorCon({}));
    expect(guard.canActivate(contextoFalso(ctxCon('CONSULTA')))).toBe(true);
  });

  it('los permisos se suman: basta con tener uno de los pedidos', () => {
    const guard = new RolesGuard(
      reflectorCon({ [CLAVE_ROLES]: ['DIRECTOR', 'CAJA'] }),
    );
    expect(guard.canActivate(contextoFalso(ctxCon('CAJA')))).toBe(true);
  });

  it('rechaza cuando no tiene ninguno de los pedidos', () => {
    const guard = new RolesGuard(reflectorCon({ [CLAVE_ROLES]: ['CAJA'] }));
    expect(() => guard.canActivate(contextoFalso(ctxCon('VENTAS')))).toThrow(
      ForbiddenException,
    );
  });

  it('DIRECTOR no es superusuario', () => {
    // Si un endpoint es de caja, el director tiene que estar listado. Un rol que
    // abre todas las puertas convierte los permisos en decoracion.
    const guard = new RolesGuard(reflectorCon({ [CLAVE_ROLES]: ['CAJA'] }));
    expect(() => guard.canActivate(contextoFalso(ctxCon('DIRECTOR')))).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza cuando no hay Ctx', () => {
    const guard = new RolesGuard(reflectorCon({ [CLAVE_ROLES]: ['VENTAS'] }));
    expect(() => guard.canActivate(contextoFalso())).toThrow(
      ForbiddenException,
    );
  });
});
