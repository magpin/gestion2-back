import { Controller, Get, Query } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { ListarFaltantesDto } from '../dto/venta.dto';
import { FaltanteService } from '../servicios/faltante.service';

/**
 * Lo que se vendió sin tener.
 *
 * Vive en ventas porque es ventas quien lo escribe, pero lo lee quien compra:
 * de ahí que `COMPRAS` e `INVENTARIO` entren igual que `DIRECTOR` y
 * `CONTADOR`. Sin `POST`: un faltante no se crea a mano, lo deja una factura
 * confirmada en descubierto.
 */
@Controller('faltantes')
@ExigeEmpresa()
export class FaltantesController {
  constructor(private readonly faltantes: FaltanteService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'INVENTARIO', 'VENTAS')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarFaltantesDto) {
    return this.faltantes.listar(ctx, q, q.soloPendientes === 'true');
  }
}
