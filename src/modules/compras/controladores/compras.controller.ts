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
  DevolverPagoDto,
  ListarComprasDto,
  PagarDto,
  SimularRentaCompraDto,
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

  /**
   * La retención de renta que llevaría la compra, sin registrar nada: el
   * concepto de cada renglón con su certeza y lo que falta contestar.
   */
  @Roles('COMPRAS', 'DIRECTOR', 'CONTADOR')
  @Post('simular-retencion')
  @HttpCode(HttpStatus.OK)
  simularRetencion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: SimularRentaCompraDto,
  ) {
    return this.compras.simularRenta(ctx, dto);
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

  /** Pagar es un acto de caja/banco, no de compra — mismos roles que un egreso manual. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/pagar')
  pagar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PagarDto,
  ) {
    return this.compras.pagar(ctx, id, dto);
  }

  /** El proveedor nos devuelve plata. Mismos roles que pagar. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/devolver-pago')
  devolverPago(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverPagoDto,
  ) {
    return this.compras.devolverPago(ctx, id, dto);
  }
}
