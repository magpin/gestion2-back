import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

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

  /** Solo un centro de costo (su id), o `SIN` para lo que quedó sin centro. */
  @IsOptional()
  @Matches(
    /^(SIN|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    {
      message: 'El centro va como su id, o SIN.',
    },
  )
  centro?: string;
}

export class PorCentroDto {
  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes?: string;

  /** Una columna por centro (por defecto) o por tipo de centro. */
  @IsOptional()
  @IsIn(['CENTRO', 'TIPO'])
  agrupar?: 'CENTRO' | 'TIPO';
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
    return this.estados.resultados(
      ctx,
      q.mes ?? mesDeHoy(),
      q.comparar,
      undefined,
      q.centro,
    );
  }

  /** El estado de resultados en columnas, una por centro de costo. */
  @Roles(...LEEN)
  @Get('resultados-por-centro')
  resultadosPorCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: PorCentroDto,
  ) {
    return this.estados.resultadosPorCentro(
      ctx,
      q.mes ?? mesDeHoy(),
      q.agrupar ?? 'CENTRO',
    );
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
