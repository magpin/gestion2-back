import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { CtxPlataforma } from '../../common/ctx';

/** Inyecta el administrador que armó el guard. */
export const Admin = createParamDecorator(
  (_datos: unknown, contexto: ExecutionContext): CtxPlataforma => {
    const req = contexto
      .switchToHttp()
      .getRequest<Request & { admin?: CtxPlataforma }>();
    if (req.admin === undefined) {
      throw new Error(
        'No hay administrador en la peticion: falta PlataformaGuard',
      );
    }
    return req.admin;
  },
);
