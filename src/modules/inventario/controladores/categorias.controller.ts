import {
  Body,
  Controller,
  Get,
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
import { CrearCategoriaDto, EditarCategoriaDto } from '../dto/categoria.dto';
import { CategoriaService } from '../servicios/categoria.service';

/**
 * Las categorías del catálogo. Ruta propia y no `productos/categorias`: es su
 * propio maestro, con su propio ciclo de vida —una categoría vive aunque no
 * tenga productos adentro—.
 */
@Controller('categorias')
@ExigeEmpresa()
export class CategoriasController {
  constructor(private readonly categorias: CategoriaService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('incluirInactivas') incluirInactivas?: string,
  ) {
    return this.categorias.listar(ctx, incluirInactivas === 'true');
  }

  @Roles('INVENTARIO', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCategoriaDto) {
    return this.categorias.crear(ctx, dto);
  }

  @Roles('INVENTARIO', 'DIRECTOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCategoriaDto,
  ) {
    return this.categorias.editar(ctx, id, dto);
  }
}
