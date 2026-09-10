import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CrearCajaDto, EditarCajaDto } from '../dto/caja.dto';
import { CajaService } from '../servicios/caja.service';

/**
 * El maestro de cajas. El libro y el arqueo viven en sus propios
 * controladores — comparten caja pero no comparten ciclo de vida, mismo
 * criterio que separa `productos.controller.ts` de `movimientos.controller.ts`.
 */
@Controller('cajas')
@ExigeEmpresa()
export class CajasController {
  constructor(private readonly cajas: CajaService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('incluirInactivas') incluirInactivas?: 'true' | 'false',
  ) {
    return this.cajas.listar(ctx, { incluirInactivas });
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cajas.porId(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCajaDto) {
    return this.cajas.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCajaDto,
  ) {
    return this.cajas.editar(ctx, id, dto);
  }

  /** No borra: desactiva. Una caja con movimientos no se puede quitar. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.cajas.desactivar(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.cajas.activar(ctx, id);
  }
}
