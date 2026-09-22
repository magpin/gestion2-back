import { Controller, Get } from '@nestjs/common';

import { Actor } from '../../../common/auth/decoradores';
import type { Ctx } from '../../../common/ctx';
import { SistemaService } from '../servicios/sistema.service';

/**
 * Lo único de la plataforma que ve un cliente: los anuncios vigentes para su
 * cuenta. Con el token de siempre, no con el de administración.
 */
@Controller('anuncios')
export class AnunciosController {
  constructor(private readonly sistema: SistemaService) {}

  @Get('vigentes')
  vigentes(@Actor() ctx: Ctx) {
    return this.sistema.vigentesPara(ctx.tenantId);
  }
}
