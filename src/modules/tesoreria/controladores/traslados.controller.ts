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
  AnularTrasladoDto,
  CrearTrasladoDto,
  GmfTrasladoDto,
} from '../dto/traslado.dto';
import {
  TrasladoService,
  type ExtremoInput,
} from '../servicios/traslado.service';

const extremo = (medio: 'CAJA' | 'BANCO', id: string): ExtremoInput =>
  medio === 'CAJA' ? { medio, cajaId: id } : { medio, cuentaBancariaId: id };

/**
 * Traslados entre caja y bancos. Registrarlos y anularlos lo hacen los mismos
 * que mueven la caja: CAJA y DIRECTOR.
 */
@Controller('traslados')
@ExigeEmpresa()
export class TrasladosController {
  constructor(private readonly traslados: TrasladoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.traslados.listar(ctx);
  }

  /** Si causa 4×1000 y cuánto, antes de guardar. */
  @Roles('DIRECTOR', 'CAJA')
  @Get('gmf-previsto')
  gmfPrevisto(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: GmfTrasladoDto) {
    return this.traslados.gmfPrevisto(
      ctx,
      extremo(q.origenMedio, q.origenId),
      extremo(q.destinoMedio, q.destinoId),
      q.valor,
    );
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get(':id')
  obtener(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.traslados.obtener(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearTrasladoDto) {
    return this.traslados.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post(':id/anular')
  anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularTrasladoDto,
  ) {
    return this.traslados.anular(ctx, id, dto.motivo);
  }
}
