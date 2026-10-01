import { Body, Controller, Get, Post } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CargarSaldosInicialesDto } from '../dto/saldos-iniciales.dto';
import { SaldosInicialesService } from '../servicios/saldos-iniciales.service';

/**
 * El arranque de caja y bancos: con cuánta plata empieza la empresa, con su
 * asiento de apertura (CA).
 */
@Controller('tesoreria/saldos-iniciales')
@ExigeEmpresa()
export class SaldosInicialesController {
  constructor(private readonly saldos: SaldosInicialesService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  estado(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.saldos.estado(ctx);
  }

  /** Asienta en el patrimonio: lo hacen quienes responden por la contabilidad. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  cargar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CargarSaldosInicialesDto,
  ) {
    return this.saldos.cargar(ctx, dto);
  }
}
