import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CrearFacturaDto } from '../../ventas/dto/factura.dto';
import { DescartarLecturaDto } from '../dto/lectura.dto';
import { DocumentoService } from '../servicios/documento.service';
import { FacturacionPedidoService } from '../servicios/facturacion-pedido.service';

/**
 * Los pedidos de clientes que María leyó (fase 8 de
 * `docs/planes/maria-facturas-y-errores.md`).
 *
 * Fuera de `facturas/` por la misma razón que `facturas-leidas` está fuera de
 * `compras/`: `GET facturas/:id` se tragaría la ruta.
 */
@Controller('pedidos-leidos')
@ExigeEmpresa()
export class PedidosLeidosController {
  constructor(
    private readonly documentos: DocumentoService,
    private readonly facturacion: FacturacionPedidoService,
  ) {}

  /** Los mismos roles que ven las facturas de venta. */
  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.documentos.listarPedidos(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA')
  @Get(':id')
  ver(@ActorEmpresa() ctx: CtxEmpresa, @Param('id', ParseUUIDPipe) id: string) {
    return this.documentos.porId(ctx, id);
  }

  /**
   * Emite la factura. Los mismos roles que `POST /facturas`, que es adonde va
   * a parar: **que el pedido lo haya leído María no le da a nadie un permiso
   * que no tiene.**
   */
  @Roles('VENTAS', 'DIRECTOR')
  @Post(':id/facturar')
  facturar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearFacturaDto,
  ) {
    return this.facturacion.facturar(ctx, id, dto);
  }

  /** Lo deja sin facturar, con el motivo. Los mismos roles que facturarlo. */
  @Roles('VENTAS', 'DIRECTOR')
  @Post(':id/descartar')
  descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DescartarLecturaDto,
  ) {
    return this.documentos.descartar(ctx, id, 'PEDIDO_VENTA', dto.motivo);
  }
}
