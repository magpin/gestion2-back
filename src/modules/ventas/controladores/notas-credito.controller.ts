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

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { AnularVentaDto, ListarVentasDto } from '../dto/venta.dto';
import { CrearNotaCreditoDto } from '../dto/nota-credito.dto';
import { NotaCreditoService } from '../servicios/nota-credito.service';
import { VentaDocumentoService } from '../servicios/venta-documento.service';

@Controller('notas-credito')
@ExigeEmpresa()
export class NotasCreditoController {
  constructor(
    private readonly notasCredito: NotaCreditoService,
    private readonly ventas: VentaDocumentoService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarVentasDto) {
    return this.ventas.listar(ctx, 'NOTA_CREDITO', q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ventas.porId(ctx, 'NOTA_CREDITO', id);
  }

  @Roles('VENTAS', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearNotaCreditoDto) {
    return this.notasCredito.crear(ctx, dto);
  }

  /** Anular es un acto de corrección, no de venta del día a día — no lo hace VENTAS. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularVentaDto,
  ): Promise<void> {
    await this.ventas.anular(ctx, id, dto.motivo);
  }
}
