import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../common/auth/decoradores';
import type { CtxEmpresa } from '../../common/ctx';
import { hoyEnColombia } from '../../common/fecha';
import { GastosService } from './gastos.service';

export class ResumenGastosDto {
  /** «2026-09». Sin él, el mes de hoy. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'El mes va como 2026-09.' })
  mes?: string;
}

export class SugerirConceptoDto {
  @IsString()
  @Length(0, 300)
  descripcion!: string;

  @IsOptional()
  @IsUUID()
  terceroId?: string;
}

/** Gastos del mes por concepto, y la sugerencia de María al registrar uno. */
@Controller('gastos')
@ExigeEmpresa()
export class GastosController {
  constructor(private readonly gastos: GastosService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'COMPRAS', 'CONSULTA')
  @Get()
  resumen(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ResumenGastosDto) {
    return this.gastos.resumen(ctx, q.mes ?? hoyEnColombia().slice(0, 7));
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'COMPRAS')
  @Get('sugerir-concepto')
  sugerir(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: SugerirConceptoDto) {
    return this.gastos.sugerir(ctx, q.descripcion, q.terceroId);
  }
}
