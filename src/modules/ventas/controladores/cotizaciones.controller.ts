import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CrearCotizacionDto } from '../dto/cotizacion.dto';
import { AnularVentaDto, ListarVentasDto } from '../dto/venta.dto';
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

  /**
   * Corrige una cotización vigente. Mismo cuerpo que crear —cliente, fecha y
   * líneas completas—: se reemplaza lo que había, no se mandan parches.
   */
  @Roles('DIRECTOR', 'VENTAS')
  @Put(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearCotizacionDto,
  ) {
    return this.ventas.editarCotizacion(ctx, id, dto);
  }

  /**
   * La descarta con motivo: el cliente no la tomó. No la borra —nada se borra—
   * y el número gastado queda con su explicación. A diferencia de anular una
   * factura, esto sí lo puede hacer quien vende: no hay asiento ni kardex
   * detrás, solo una oferta que no se concretó.
   */
  @Roles('DIRECTOR', 'VENTAS')
  @Post(':id/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  async descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularVentaDto,
  ) {
    await this.ventas.descartarCotizacion(ctx, id, dto.motivo);
  }
}
