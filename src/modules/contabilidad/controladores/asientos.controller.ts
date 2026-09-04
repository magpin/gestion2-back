import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import {
  AnularAsientoDto,
  CrearAsientoDto,
  FiltroAsientosDto,
} from '../dto/asiento.dto';
import { AsientoService } from '../servicios/asiento.service';

/**
 * No hay PATCH.
 *
 * Un asiento registrado no se edita: `fn_asiento_inmutable` lo rechaza, y
 * exponer el verbo seria prometer algo que la base niega. La correccion es
 * anular y volver a hacerlo, o un contra-asiento si el periodo ya cerro.
 */
@Controller('asientos')
@ExigeEmpresa()
export class AsientosController {
  constructor(private readonly asientos: AsientoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: FiltroAsientosDto) {
    return this.asientos.listar(ctx, q, q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.asientos.porId(ctx, id);
  }

  /** Solo CONTADOR: `0007` lo define como el unico que escribe asientos manuales. */
  @Roles('CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearAsientoDto) {
    return this.asientos.crear(ctx, dto);
  }

  @Roles('CONTADOR')
  @Post(':id/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularAsientoDto,
  ): Promise<void> {
    await this.asientos.anular(ctx, id, dto.motivo);
  }
}
