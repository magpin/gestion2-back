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
  CargaInicialCajaDto,
  ListarMovimientosCajaDto,
} from '../dto/caja-movimiento.dto';
import { CajaMovimientoService } from '../servicios/caja-movimiento.service';

/**
 * El libro de una caja. No hay `PATCH` ni `DELETE`: un movimiento no se
 * edita ni se borra — se corrige con el movimiento contrario, mismo
 * criterio que el kardex.
 */
@Controller('cajas/:id/movimientos')
@ExigeEmpresa()
export class CajaMovimientosController {
  constructor(private readonly movimientos: CajaMovimientoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cajaId: string,
    @Query() q: ListarMovimientosCajaDto,
  ) {
    return this.movimientos.listar(ctx, cajaId, q);
  }

  /** Solo una vez por caja: el saldo con el que arranca. No genera asiento. */
  @Roles('CAJA', 'DIRECTOR')
  @Post('saldo-inicial')
  saldoInicial(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cajaId: string,
    @Body() dto: CargaInicialCajaDto,
  ) {
    return this.movimientos.registrarSaldoInicial(ctx, cajaId, dto);
  }
}
