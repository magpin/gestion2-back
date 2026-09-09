import {
  Body,
  Controller,
  Get,
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
  CargaInicialDto,
  EntradaAjusteDto,
  FiltroMovimientosDto,
  SalidaAjusteDto,
} from '../dto/movimiento.dto';
import { KardexService } from '../servicios/kardex.service';

/**
 * El kardex. No hay `PATCH` ni `DELETE`: un movimiento no se edita ni se
 * borra — se corrige con el movimiento contrario. Ver el porqué en
 * `0025_producto_inventario.sql`.
 */
@Controller('productos/:id/movimientos')
@ExigeEmpresa()
export class MovimientosController {
  constructor(private readonly kardex: KardexService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) productoId: string,
    @Query() q: FiltroMovimientosDto,
  ) {
    // No se hace spread: `q` es una instancia de PaginacionDto y `salto` es un
    // getter — copiarlo a un objeto literal lo perdería.
    q.productoId = productoId;
    return this.kardex.listar(ctx, q);
  }

  /** Solo una vez por producto: la existencia con la que arranca. No genera asiento. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post('carga-inicial')
  cargaInicial(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) productoId: string,
    @Body() dto: CargaInicialDto,
  ) {
    return this.kardex.registrarCargaInicial(ctx, productoId, dto);
  }

  /** Sobrante en bodega. Genera un asiento automático. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post('entrada-ajuste')
  entradaAjuste(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) productoId: string,
    @Body() dto: EntradaAjusteDto,
  ) {
    return this.kardex.registrarEntradaAjuste(ctx, productoId, dto);
  }

  /** Faltante en bodega. Se valora al costo promedio vigente. Genera un asiento automático. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post('salida-ajuste')
  salidaAjuste(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) productoId: string,
    @Body() dto: SalidaAjusteDto,
  ) {
    return this.kardex.registrarSalidaAjuste(ctx, productoId, dto);
  }
}
