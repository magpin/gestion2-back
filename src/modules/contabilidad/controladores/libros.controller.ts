import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import { AuxiliarTerceroDto, MayorDto, RangoDto } from '../dto/libros.dto';
import { LibrosService } from '../servicios/libros.service';

/**
 * Los libros no son tablas: son consultas sobre `asiento_linea`. Solo lectura,
 * y CONSULTA entra a todas — ver el libro no cambia nada.
 */
@Controller('libros')
@ExigeEmpresa()
@Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
export class LibrosController {
  constructor(private readonly libros: LibrosService) {}

  @Get('diario')
  diario(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: RangoDto) {
    return this.libros.diario(ctx, q.desde, q.hasta);
  }

  @Get('mayor')
  mayor(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: MayorDto) {
    return this.libros.mayor(
      ctx,
      q.cuentaId,
      q.desde,
      q.hasta,
      q.centroCostoId,
    );
  }

  @Get('auxiliar-tercero')
  auxiliarTercero(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: AuxiliarTerceroDto,
  ) {
    return this.libros.auxiliarTercero(
      ctx,
      q.terceroId,
      q.desde,
      q.hasta,
      q.centroCostoId,
    );
  }

  @Get('balance-prueba/:periodoId')
  balancePrueba(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('periodoId', ParseUUIDPipe) periodoId: string,
  ) {
    return this.libros.balancePrueba(ctx, periodoId);
  }
}
