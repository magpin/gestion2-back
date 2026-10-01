import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../common/auth/decoradores';
import type { CtxEmpresa } from '../../common/ctx';
import { hoyEnColombia } from '../../common/fecha';
import { EstadosFinancierosService } from './estados-financieros.service';

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PeriodoEstadosDto {
  /** «2026-09». Sin él, el mes de hoy. */
  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes?: string;

  /** El mes contra el que se compara. */
  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  comparar?: string;
}

export class ProyectadoDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(26)
  semanas?: number;
}

/** Quien ve la plata de la empresa entera: los mismos que ven los libros. */
const LEEN = ['DIRECTOR', 'CONTADOR', 'CONSULTA'] as const;

@Controller('estados-financieros')
@ExigeEmpresa()
export class EstadosFinancierosController {
  constructor(private readonly estados: EstadosFinancierosService) {}

  @Roles(...LEEN)
  @Get('resultados')
  resultados(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: PeriodoEstadosDto) {
    return this.estados.resultados(ctx, q.mes ?? mesDeHoy(), q.comparar);
  }

  @Roles(...LEEN)
  @Get('balance')
  balance(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: PeriodoEstadosDto) {
    return this.estados.balance(ctx, q.mes ?? mesDeHoy(), q.comparar);
  }

  @Roles(...LEEN)
  @Get('flujo')
  flujo(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: PeriodoEstadosDto) {
    return this.estados.flujo(ctx, q.mes ?? mesDeHoy());
  }

  @Roles(...LEEN)
  @Get('flujo-proyectado')
  proyectado(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ProyectadoDto) {
    return this.estados.proyectado(ctx, q.semanas ?? 8);
  }
}

function mesDeHoy(): string {
  return hoyEnColombia().slice(0, 7);
}
