import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { TrazabilidadService } from '../servicios/trazabilidad.service';

/**
 * El historial de un asiento. Cuelga de `/asientos/:id` porque es una vista
 * más del asiento, y los roles son los mismos que para verlo (`GET /asientos`).
 */
@Controller('asientos')
@ExigeEmpresa()
export class TrazabilidadController {
  constructor(private readonly trazabilidad: TrazabilidadService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get(':id/trazabilidad')
  deAsiento(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trazabilidad.deAsiento(ctx, id);
  }
}
