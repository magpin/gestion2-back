import { Body, Controller, Get, Post, Query } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import {
  AbrirPeriodoDto,
  ListarPeriodosDto,
  ResumenPeriodosDto,
} from '../dto/periodo.dto';
import { PeriodoService } from '../servicios/periodo.service';

@Controller('periodos')
@ExigeEmpresa()
export class PeriodosController {
  constructor(private readonly periodos: PeriodoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarPeriodosDto) {
    return this.periodos.listar(ctx, q.anio);
  }

  /** El período en curso. Siempre existe: el calendario se pone al día solo. */
  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get('actual')
  actual(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.periodos.actual(ctx);
  }

  /** El calendario por mes, trimestre, semestre o año, con sus cifras. */
  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get('resumen')
  resumen(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ResumenPeriodosDto) {
    return this.periodos.resumen(ctx, q.agrupacion, q.anio);
  }

  /**
   * Abrir a mano ya casi no hace falta —el calendario se abre solo—; queda
   * para cargar historia de un sistema anterior. Si el mes existe, lo devuelve.
   */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  abrir(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AbrirPeriodoDto) {
    return this.periodos.abrir(ctx, dto.anio, dto.mes);
  }
}
