import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CargarHistoricasDto } from '../dto/historico.dto';
import { HistoricoService } from '../servicios/historico.service';

/**
 * Las facturas de venta de antes de usar el sistema (fase 10).
 *
 * Fuera de `facturas/` por lo mismo que `facturas-leidas` y `pedidos-leidos`:
 * `facturas/:id` se tragaría la ruta.
 *
 * **Director y contador**, no ventas: cargar el histórico es armar la cartera
 * con la que arranca la empresa, y eso es contabilidad, no facturar.
 */
@Controller('facturas-historicas')
@ExigeEmpresa()
export class FacturasHistoricasController {
  constructor(private readonly historico: HistoricoService) {}

  /**
   * Carga un envío. `?simular=true` corre todo y lo deshace: dice qué pasaría
   * sin escribir nada. Todas o ninguna: si una tiene un problema, no entra
   * ninguna, y la respuesta dice cuál y por qué.
   */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  @HttpCode(HttpStatus.OK)
  cargar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CargarHistoricasDto,
    @Query('simular') simular?: string,
  ) {
    return this.historico.cargar(ctx, dto.facturas, simular === 'true');
  }
}
