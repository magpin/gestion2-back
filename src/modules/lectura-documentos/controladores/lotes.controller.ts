import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CrearLoteDto } from '../dto/lectura.dto';
import { LoteService } from '../servicios/lote.service';

/**
 * Varios documentos soltados juntos en el chat de María (tanda 3, 0067).
 *
 * Los roles son los del chat —los de «Configurar empresa»—, porque es desde
 * ahí que se suelta un lote. Qué se lee de cada archivo lo decide además el
 * rol de quien lo subió: un contador no factura pedidos, y el lote lo dice en
 * ese archivo en vez de fallar entero.
 */
@Controller('lotes')
@ExigeEmpresa()
export class LotesController {
  constructor(private readonly lotes: LoteService) {}

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearLoteDto) {
    return this.lotes.crear(ctx, dto.archivos);
  }

  /** Los últimos de quien pregunta: los que el chat muestra entre sus turnos. */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.lotes.listar(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Get(':id')
  ver(@ActorEmpresa() ctx: CtxEmpresa, @Param('id', ParseUUIDPipe) id: string) {
    return this.lotes.ver(ctx, id);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post(':id/detener')
  detener(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lotes.detener(ctx, id);
  }
}
