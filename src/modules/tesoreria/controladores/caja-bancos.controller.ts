import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import { CajaBancosService } from '../servicios/caja-bancos.service';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class DiaDto {
  @IsOptional()
  @Matches(FECHA, { message: 'La fecha va como 2026-09-28.' })
  fecha?: string;
}

export class RangoDto {
  @IsOptional()
  @Matches(FECHA, { message: 'La fecha va como 2026-09-28.' })
  desde?: string;

  @IsOptional()
  @Matches(FECHA, { message: 'La fecha va como 2026-09-28.' })
  hasta?: string;
}

/** Los que ven la plata: los mismos que ven Caja y bancos. */
const LEEN = ['DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA'] as const;

/**
 * Caja y bancos (Fase 6 de las pantallas complementarias): el día de una caja
 * y los movimientos de todas las cuentas juntos.
 */
@Controller()
@ExigeEmpresa()
export class CajaBancosController {
  constructor(private readonly vistas: CajaBancosService) {}

  @Roles(...LEEN)
  @Get('cajas/:id/dia')
  dia(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: DiaDto,
  ) {
    return this.vistas.diaDeCaja(ctx, id, q.fecha);
  }

  /** Sin rango, los últimos 7 días. */
  @Roles(...LEEN)
  @Get('tesoreria/movimientos')
  movimientos(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: RangoDto) {
    const hasta = q.hasta ?? hoyEnColombia();
    const desde =
      q.desde ??
      new Date(Date.parse(`${hasta}T00:00:00Z`) - 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    return this.vistas.movimientos(ctx, desde, hasta);
  }
}
