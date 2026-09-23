import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { CrearFacturaDto } from '../../ventas/dto/factura.dto';
import { VentasApi } from '../../ventas/ventas.api';
import type { PedidoCruzado } from './cruce.service';
import { DocumentoService } from './documento.service';

/**
 * Emite la factura de venta que una persona armó a partir de un pedido leído.
 *
 * Hermano de `ConfirmacionFacturaService`, con una diferencia que viene de
 * ventas: **acá las líneas sí vienen de la petición**. En una compra los
 * montos salen del papel y la persona solo contesta lo que faltó; en una venta
 * el precio lo pone la lista —el servidor no acepta uno— y lo que se decide son
 * el cliente, los productos y las cantidades, que la persona revisó y pudo
 * cambiar en el formulario de siempre. Es lo mismo que manda `POST /facturas`.
 *
 * Lo único que agrega esta puerta es decir **de qué pedido salió**, y eso lo
 * pone el servidor: si viniera en el cuerpo, cualquier factura podría decir que
 * la leyó María.
 */
@Injectable()
export class FacturacionPedidoService {
  private readonly log = new Logger(FacturacionPedidoService.name);

  constructor(
    private readonly documentos: DocumentoService,
    private readonly ventas: VentasApi,
  ) {}

  async facturar(ctx: CtxEmpresa, documentoId: string, dto: CrearFacturaDto) {
    const documento = await this.documentos.porId(ctx, documentoId);
    if (documento.tipo !== 'PEDIDO_VENTA') {
      throw new BadRequestException(
        'Ese documento no es un pedido de cliente.',
      );
    }
    const cruzado = documento.extraido as PedidoCruzado | null;
    if (cruzado?.pedido === undefined) {
      throw new BadRequestException(
        'Esa lectura no tiene un pedido del cual armar la factura.',
      );
    }

    const factura = await this.ventas.crearFactura(ctx, dto, {
      documentoLeidoId: documentoId,
    });
    this.log.log(
      `Pedido ${documentoId} facturado como ${factura.id}, ${dto.lineas.length} líneas.`,
    );
    return factura;
  }
}
