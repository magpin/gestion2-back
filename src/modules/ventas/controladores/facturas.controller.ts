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
import { ConvertirCotizacionDto, ExistenciaDto } from '../dto/cotizacion.dto';
import { CrearFacturaDto } from '../dto/factura.dto';
import {
  AnularVentaDto,
  CobrarDto,
  DevolverCobroDto,
  ListarVentasDto,
} from '../dto/venta.dto';
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

  /** El número que sale si se emite ahora. Antes de `:id`, que lo tomaría por un id. */
  @Roles('VENTAS', 'DIRECTOR')
  @Get('numeracion')
  numeracion(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.facturas.numeracion(ctx);
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

  /** Cómo quedaría la factura, sin emitirla: totales, retenciones y asiento. */
  @Roles('VENTAS', 'DIRECTOR')
  @Post('previo')
  @HttpCode(HttpStatus.OK)
  previo(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearFacturaDto) {
    return this.facturas.previo(ctx, dto);
  }

  /** Qué productos no alcanzan, antes de emitir. Solo lee. */
  @Roles('VENTAS', 'DIRECTOR')
  @Post('existencia')
  @HttpCode(HttpStatus.OK)
  existencia(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: ExistenciaDto) {
    return this.facturas.existencia(ctx, dto.lineas);
  }

  /** Cómo quedaría la factura de una cotización, sin emitirla. */
  @Roles('VENTAS', 'DIRECTOR')
  @Post('desde-cotizacion/:cotizacionId/previo')
  @HttpCode(HttpStatus.OK)
  previoConversion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('cotizacionId', ParseUUIDPipe) cotizacionId: string,
    @Body() dto: ConvertirCotizacionDto,
  ) {
    return this.facturas.previoConversion(ctx, cotizacionId, dto);
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
    return this.facturas.convertirCotizacion(ctx, cotizacionId, dto);
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

  /** Cobrar es un acto de caja/banco, no de venta — mismos roles que un ingreso manual. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/cobrar')
  cobrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CobrarDto,
  ) {
    return this.ventas.cobrar(ctx, id, dto);
  }

  /**
   * Devolverle plata al cliente sobre una factura que sigue valiendo lo
   * mismo. Mismos roles que cobrar: sale de la caja o del banco, y quien
   * decide eso es quien maneja la plata, no quien vende.
   */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/devolver-cobro')
  devolverCobro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverCobroDto,
  ) {
    return this.ventas.devolverCobro(ctx, id, dto);
  }
}
