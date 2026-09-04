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

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import {
  CrearComprobanteDto,
  EditarComprobanteDto,
} from '../dto/comprobante.dto';
import { ComprobanteService } from '../servicios/comprobante.service';

@Controller('comprobantes')
@ExigeEmpresa()
export class ComprobantesController {
  constructor(private readonly comprobantes: ComprobanteService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('incluirInactivos') incluirInactivos?: string,
  ) {
    return this.comprobantes.listar(ctx, incluirInactivos === 'true');
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearComprobanteDto) {
    return this.comprobantes.crear(ctx, dto);
  }

  /** Solo el nombre: el prefijo y la naturaleza ya numeraron asientos. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarComprobanteDto,
  ) {
    return this.comprobantes.editar(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.comprobantes.desactivar(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.comprobantes.activar(ctx, id);
  }
}
