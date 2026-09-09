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
import { CrearCotizacionDto } from '../dto/cotizacion.dto';
import { ListarVentasDto } from '../dto/venta.dto';
import { VentaDocumentoService } from '../servicios/venta-documento.service';

/**
 * Cotizaciones. Convertir una a factura vive en `facturas.controller.ts`
 * (`POST /facturas/desde-cotizacion/:cotizacionId`): es un acto de
 * `FacturaService`, no de este servicio — ver el porqué en
 * `VentaDocumentoService`.
 */
@Controller('cotizaciones')
@ExigeEmpresa()
export class CotizacionesController {
  constructor(private readonly ventas: VentaDocumentoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarVentasDto) {
    return this.ventas.listar(ctx, 'COTIZACION', q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ventas.porId(ctx, 'COTIZACION', id);
  }

  @Roles('VENTAS', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCotizacionDto) {
    return this.ventas.crearCotizacion(ctx, dto);
  }
}
