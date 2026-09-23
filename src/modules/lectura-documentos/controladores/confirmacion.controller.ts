import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { ConfirmarDto } from '../dto/lectura.dto';
import { ConfirmacionService } from '../servicios/confirmacion.service';

/**
 * Lo único que escribe en la configuración de la empresa, y solo cuando una
 * persona lo pide.
 *
 * Va bajo el documento —`documentos/:id/confirmar`— y no suelto, porque los
 * valores salen de ese documento: lo que llega es qué campos se aprobaron y,
 * si la persona corrigió alguno —sobre todo lo leído dudoso—, su corrección.
 * Lo corregido queda escrito aparte en la lectura: se ve qué dijo el papel y
 * qué decidió la persona.
 */
@Controller('configuracion/ia')
@ExigeEmpresa()
export class ConfirmacionController {
  constructor(private readonly confirmacion: ConfirmacionService) {}

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('documentos/:id/confirmar')
  confirmar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarDto,
  ) {
    return this.confirmacion.confirmar(ctx, id, dto.campos, dto.correcciones);
  }
}
