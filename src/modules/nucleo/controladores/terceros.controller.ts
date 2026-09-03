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
import {
  CrearTerceroDto,
  EditarTerceroDto,
  ListarTercerosDto,
} from '../dto/tercero.dto';
import { TerceroService } from '../servicios/tercero.service';

@Controller('terceros')
@ExigeEmpresa()
export class TercerosController {
  constructor(private readonly terceros: TerceroService) {}

  /** Búsqueda sin tildes ni mayúsculas: "medellin" encuentra "Medellín". */
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarTercerosDto) {
    return this.terceros.listar(ctx, q, {
      esCliente: q.esCliente,
      esProveedor: q.esProveedor,
      incluirInactivos: q.incluirInactivos,
    });
  }

  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.terceros.porId(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'COMPRAS')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearTerceroDto) {
    return this.terceros.crear(ctx, dto);
  }

  /**
   * Cambia el tercero de hoy en adelante. Los documentos ya emitidos guardan
   * copia de sus datos al momento de emitirse y no se tocan.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'COMPRAS')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarTerceroDto,
  ) {
    return this.terceros.editar(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.terceros.desactivar(ctx, id);
  }
}
