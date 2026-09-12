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
import { CrearCuentaBancariaDto } from '../dto/cuenta-bancaria.dto';
import { CuentaBancariaService } from '../servicios/cuenta-bancaria.service';

/**
 * El maestro de cuentas bancarias. El libro vive en su propio controlador
 * — comparte cuenta bancaria pero no comparte ciclo de vida, mismo
 * criterio que separa `CajasController` de `CajaMovimientosController`.
 */
@Controller('cuentas-bancarias')
@ExigeEmpresa()
export class CuentasBancariasController {
  constructor(private readonly cuentas: CuentaBancariaService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('incluirInactivas') incluirInactivas?: 'true' | 'false',
  ) {
    return this.cuentas.listar(ctx, { incluirInactivas });
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cuentas.porId(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCuentaBancariaDto) {
    return this.cuentas.crear(ctx, dto);
  }

  /** No borra: desactiva. Una cuenta bancaria con movimientos no se puede quitar. */
  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.cuentas.desactivar(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.cuentas.activar(ctx, id);
  }
}
