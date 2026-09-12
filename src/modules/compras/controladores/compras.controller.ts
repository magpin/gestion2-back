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
import {
  AnularCompraDto,
  CrearCompraDto,
  ListarComprasDto,
  PagarEfectivoDto,
} from '../dto/compra.dto';
import { CompraService } from '../servicios/compra.service';

/**
 * Facturas de compra. Un solo tipo de documento, un solo servicio —a
 * diferencia de `ventas`, acá no hace falta el patrón "genérico por tipo"
 * de `VentaDocumentoService`.
 */
@Controller('compras')
@ExigeEmpresa()
export class ComprasController {
  constructor(private readonly compras: CompraService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarComprasDto) {
    return this.compras.listar(ctx, q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.compras.porId(ctx, id);
  }

  @Roles('COMPRAS', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCompraDto) {
    return this.compras.crear(ctx, dto);
  }

  /** Anular es un acto de corrección, no de compra del día a día — no lo hace COMPRAS. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularCompraDto,
  ): Promise<void> {
    await this.compras.anular(ctx, id, dto.motivo);
  }

  /** Pagar es un acto de caja, no de compra — mismos roles que un egreso manual. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/pagar-efectivo')
  pagarEfectivo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PagarEfectivoDto,
  ) {
    return this.compras.pagarEfectivo(ctx, id, dto);
  }
}
