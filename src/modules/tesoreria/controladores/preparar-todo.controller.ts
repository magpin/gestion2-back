import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { PrepararTodoService } from '../servicios/preparar-todo.service';

/**
 * `POST /configuracion/preparar-todo`: deja la empresa lista para operar. Lo
 * corre el asistente al terminar, y el administrador una vez para una
 * empresa que ya existía. Ver `PrepararTodoService`.
 */
@Controller('configuracion')
@ExigeEmpresa()
export class PrepararTodoController {
  constructor(private readonly preparar: PrepararTodoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'ADMIN_TENANT')
  @Post('preparar-todo')
  @HttpCode(HttpStatus.OK)
  prepararTodo(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.preparar.preparar(ctx);
  }
}
