import {
  Body,
  Controller,
  Get,
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
import {
  CargaInicialBancoDto,
  ListarMovimientosBancoDto,
  RegistrarMovimientoBancoDto,
} from '../dto/banco-movimiento.dto';
import { BancoMovimientoService } from '../servicios/banco-movimiento.service';

/**
 * El libro de una cuenta bancaria. No hay `PATCH` ni `DELETE`: un
 * movimiento no se edita ni se borra — se corrige con el movimiento
 * contrario, mismo criterio que el libro de caja.
 */
@Controller('cuentas-bancarias/:id/movimientos')
@ExigeEmpresa()
export class BancoMovimientosController {
  constructor(private readonly movimientos: BancoMovimientoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Query() q: ListarMovimientosBancoDto,
  ) {
    return this.movimientos.listar(ctx, cuentaBancariaId, q);
  }

  /** Solo una vez por cuenta: el saldo con el que arranca. No genera asiento. */
  @Roles('CAJA', 'DIRECTOR')
  @Post('saldo-inicial')
  saldoInicial(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Body() dto: CargaInicialBancoDto,
  ) {
    return this.movimientos.registrarSaldoInicial(ctx, cuentaBancariaId, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post()
  registrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Body() dto: RegistrarMovimientoBancoDto,
  ) {
    return this.movimientos.registrarMovimiento(ctx, cuentaBancariaId, dto);
  }
}
