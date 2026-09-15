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
import { AnularCompraDto, ListarComprasDto } from '../dto/compra.dto';
import {
  CrearNotaCreditoCompraDto,
  CrearNotaDebitoCompraDto,
} from '../dto/nota-compra.dto';
import { CompraNotaService } from '../servicios/compra-nota.service';
import { CompraService } from '../servicios/compra.service';

/**
 * Las notas del proveedor. Dos rutas hermanas bajo `compras/` porque son
 * documentos de compra —viven en `compra_documento` desde `0039`— y no un
 * módulo aparte: quien registra la factura del proveedor es quien registra su
 * nota.
 *
 * Anular una nota reusa `CompraService.anular`, que ya sabe anular el asiento
 * y rechazar si tiene pagos encima.
 */
@Controller('compras/notas')
@ExigeEmpresa()
export class NotasCompraController {
  constructor(
    private readonly notas: CompraNotaService,
    private readonly compras: CompraService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get('credito')
  listarCredito(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarComprasDto) {
    return this.compras.listar(ctx, q, 'NOTA_CREDITO');
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get('debito')
  listarDebito(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarComprasDto) {
    return this.compras.listar(ctx, q, 'NOTA_DEBITO');
  }

  @Roles('COMPRAS', 'DIRECTOR')
  @Post('credito')
  crearCredito(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearNotaCreditoCompraDto,
  ) {
    return this.notas.crearNotaCredito(ctx, dto);
  }

  @Roles('COMPRAS', 'DIRECTOR')
  @Post('debito')
  crearDebito(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearNotaDebitoCompraDto,
  ) {
    return this.notas.crearNotaDebito(ctx, dto);
  }

  /** Anular es corrección, no operación del día a día — no lo hace COMPRAS. */
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
}
