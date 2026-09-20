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
 * valores salen de ese documento y no de la petición: lo que llega es qué campos
 * se aprobaron. Un navegador no puede aplicar un valor que nadie leyó de un
 * archivo, y la trazabilidad queda completa: este dato salió de ese documento.
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
    return this.confirmacion.confirmar(ctx, id, dto.campos);
  }
}
