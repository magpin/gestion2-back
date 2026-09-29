import { Controller, Get } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../common/auth/decoradores';
import type { CtxEmpresa } from '../../common/ctx';
import { TableroService } from './tablero.service';

@Controller('tablero')
@ExigeEmpresa()
export class TableroController {
  constructor(private readonly tablero: TableroService) {}

  /**
   * Quien ve la plata de la empresa: caja y bancos, cartera y pagos. El
   * resultado del mes solo va a quien ve los estados financieros.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get('plata')
  plata(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.tablero.plata(ctx);
  }
}
