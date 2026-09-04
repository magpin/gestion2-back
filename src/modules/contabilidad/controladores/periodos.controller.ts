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

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import { AbrirPeriodoDto, ListarPeriodosDto } from '../dto/periodo.dto';
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

  /** El periodo de hoy, o null si nadie lo abrio. Decide si la pantalla deja digitar. */
  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get('actual')
  actual(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.periodos.porFecha(ctx, new Date());
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  abrir(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AbrirPeriodoDto) {
    return this.periodos.abrir(ctx, dto.anio, dto.mes);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.periodos.cerrar(ctx, id);
  }

  /**
   * Solo DIRECTOR: reabrir es deshacer una promesa. Los estados financieros que
   * salieron de ese mes ya se entregaron, y volver a tocarlo los cambia.
   */
  @Roles('DIRECTOR')
  @Post(':id/reabrir')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reabrir(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.periodos.reabrir(ctx, id);
  }
}
