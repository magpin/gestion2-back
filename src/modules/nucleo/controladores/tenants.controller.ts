import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { Publico } from '../../../common/auth/decoradores';
import { CrearTenantDto } from '../dto/tenant.dto';
import { TenantService } from '../servicios/tenant.service';
import { ProvisionGuard } from './provision.guard';

/**
 * Alta de cuentas. Es público porque ocurre antes de que exista usuario, pero
 * exige la clave de instalación en la cabecera `x-clave-provision`: sin ella,
 * cualquiera podría crear cuentas en el sistema.
 *
 * Es el único punto que usa la conexión con BYPASSRLS, y lo único que puede
 * hacer es crear el tenant y su primer administrador.
 */
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantService) {}

  @Publico()
  @UseGuards(ProvisionGuard)
  @Post()
  async crear(@Body() dto: CrearTenantDto) {
    return this.tenants.crear(dto);
  }
}
