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
  CerrarCorteDto,
  ListarCortesDto,
  PrevioCorteDto,
} from '../dto/banco-corte.dto';
import { BancoCorteService } from '../servicios/banco-corte.service';

/**
 * El corte diario de una cuenta bancaria. Sin `PATCH` ni `DELETE`: un corte
 * cerrado queda congelado, igual que un arqueo.
 */
@Controller('cuentas-bancarias/:id/cortes')
@ExigeEmpresa()
export class BancoCortesController {
  constructor(private readonly cortes: BancoCorteService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Query() q: ListarCortesDto,
  ) {
    return this.cortes.listar(ctx, cuentaBancariaId, q);
  }

  /** El día como está hoy en el libro, antes de cortarlo. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get('previo')
  previo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Query() q: PrevioCorteDto,
  ) {
    return this.cortes.previo(ctx, cuentaBancariaId, q.fecha);
  }

  /** Mismos roles que cerrar un arqueo: lo hace quien maneja la plata. */
  @Roles('CAJA', 'DIRECTOR')
  @Post()
  cerrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Body() dto: CerrarCorteDto,
  ) {
    return this.cortes.cerrar(ctx, cuentaBancariaId, dto);
  }
}
