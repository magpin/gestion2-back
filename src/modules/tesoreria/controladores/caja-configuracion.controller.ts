import { Body, Controller, Get, Put } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { FijarCuentaDiferenciaDto } from '../dto/caja-configuracion.dto';
import { CajaConfiguracionService } from '../servicios/caja-configuracion.service';

/**
 * `tesoreria/configuracion`, no `cajas/configuracion`: `CajasController` ya
 * tiene `GET /cajas/:id` con `ParseUUIDPipe` — anidar acá bajo `cajas`
 * haría que `/cajas/configuracion` compitiera con esa ruta. Mismo nivel que
 * el módulo, igual que `inventario/configuracion` cuelga de `inventario`
 * y no de `productos`.
 */
@Controller('tesoreria/configuracion')
@ExigeEmpresa()
export class CajaConfiguracionController {
  constructor(private readonly configuracion: CajaConfiguracionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA')
  @Get()
  obtener(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.obtener(ctx);
  }

  /** Solo CONTADOR/DIRECTOR: elegir la cuenta de diferencia es juicio contable, no operación de caja. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Put()
  fijarCuentaDiferencia(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FijarCuentaDiferenciaDto,
  ) {
    return this.configuracion.fijarCuentaDiferencia(
      ctx,
      dto.cuentaDiferenciaId,
    );
  }
}
