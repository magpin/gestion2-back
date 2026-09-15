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
import { CrearNotaDebitoDto } from '../dto/nota-debito.dto';
import { NotaDebitoService } from '../servicios/nota-debito.service';
import { VentaDocumentoService } from '../servicios/venta-documento.service';

/**
 * Notas débito de venta: le cobran más al cliente sobre una factura que ya
 * existe. Hermano de `notas-credito.controller.ts`, con la misma reparticion
 * de roles: emitir es del día a día de ventas, anular es corrección.
 */
@Controller('notas-debito')
@ExigeEmpresa()
export class NotasDebitoController {
  constructor(
    private readonly notasDebito: NotaDebitoService,
    private readonly ventas: VentaDocumentoService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarVentasDto) {
    return this.ventas.listar(ctx, 'NOTA_DEBITO', q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ventas.porId(ctx, 'NOTA_DEBITO', id);
  }

  @Roles('VENTAS', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearNotaDebitoDto) {
    return this.notasDebito.crear(ctx, dto);
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
