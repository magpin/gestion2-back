import { Body, Controller, Get, Put } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { FijarCuentaAjusteDto } from '../dto/configuracion.dto';
import { ConfiguracionService } from '../servicios/configuracion.service';

@Controller('inventario/configuracion')
@ExigeEmpresa()
export class ConfiguracionController {
  constructor(private readonly configuracion: ConfiguracionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO')
  @Get()
  obtener(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.obtener(ctx);
  }

  /** Solo CONTADOR/DIRECTOR: elegir la contrapartida es juicio contable, no operación de bodega. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Put()
  fijarCuentaAjuste(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FijarCuentaAjusteDto,
  ) {
    return this.configuracion.fijarCuentaAjuste(ctx, dto.cuentaAjusteId);
  }
}
