import { Body, Controller, Get, Put } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  FijarCuentaAjusteDto,
  FijarExistenciaNegativaDto,
} from '../dto/configuracion.dto';
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

  /**
   * Vender sin existencia: DIRECTOR solamente.
   *
   * No es una preferencia de pantalla, es asumir que el kardex de un producto
   * pueda quedar en rojo y que el costo de esa venta se valore con el último
   * promedio conocido. Quien responde por el inventario lo decide; el contador
   * no tiene por qué cargar con eso y la bodega no debería poder cambiarlo.
   */
  @Roles('DIRECTOR')
  @Put('existencia-negativa')
  fijarExistenciaNegativa(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FijarExistenciaNegativaDto,
  ) {
    return this.configuracion.fijarExistenciaNegativa(ctx, dto.permite);
  }
}
