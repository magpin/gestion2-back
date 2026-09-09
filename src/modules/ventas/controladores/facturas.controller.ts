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
import { ConvertirCotizacionDto } from '../dto/cotizacion.dto';
import { CrearFacturaDto } from '../dto/factura.dto';
import { AnularVentaDto, ListarVentasDto } from '../dto/venta.dto';
import { FacturaService } from '../servicios/factura.service';
import { VentaDocumentoService } from '../servicios/venta-documento.service';

/**
 * Facturas de venta. Listar y consultar reusan `VentaDocumentoService`
 * —mismo método que usan las cotizaciones, filtrado por `tipo`—; crear es
 * de `FacturaService`, el único que asienta y mueve el kardex.
 */
@Controller('facturas')
@ExigeEmpresa()
export class FacturasController {
  constructor(
    private readonly facturas: FacturaService,
    private readonly ventas: VentaDocumentoService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarVentasDto) {
    return this.ventas.listar(ctx, 'FACTURA', q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ventas.porId(ctx, 'FACTURA', id);
  }

  @Roles('VENTAS', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearFacturaDto) {
    return this.facturas.crear(ctx, dto);
  }

  /**
   * Convertir una cotización en factura: mismos roles que crear una
   * factura directa — es el mismo acto de venta, solo que reusando líneas
   * ya cargadas en vez de digitarlas de nuevo.
   */
  @Roles('VENTAS', 'DIRECTOR')
  @Post('desde-cotizacion/:cotizacionId')
  convertir(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('cotizacionId', ParseUUIDPipe) cotizacionId: string,
    @Body() dto: ConvertirCotizacionDto,
  ) {
    return this.facturas.convertirCotizacion(ctx, cotizacionId, dto.fecha);
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
