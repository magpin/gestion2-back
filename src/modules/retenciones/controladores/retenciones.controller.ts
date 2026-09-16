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
import {
  CargarUvtDto,
  CrearConceptoDto,
  EditarConceptoDto,
} from '../dto/retencion.dto';
import { RetencionService } from '../servicios/retencion.service';

/**
 * El catálogo de retenciones y la UVT. Es configuración contable, no operación
 * del día a día: lo carga y lo corrige quien sabe de impuestos.
 */
@Controller('retenciones')
@ExigeEmpresa()
export class RetencionesController {
  constructor(private readonly retenciones: RetencionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('conceptos')
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query('anio') anio?: string) {
    return this.retenciones.listar(
      ctx,
      anio === undefined ? undefined : Number(anio),
    );
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('conceptos')
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearConceptoDto) {
    return this.retenciones.crear(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Patch('conceptos/:id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarConceptoDto,
  ) {
    return this.retenciones.editar(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('uvt')
  listarUvt(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.retenciones.listarUvt(ctx);
  }

  /** La fija la DIAN cada año por resolución. Acá solo se registra cuál es. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('uvt')
  cargarUvt(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CargarUvtDto) {
    return this.retenciones.cargarUvt(ctx, dto);
  }
}
