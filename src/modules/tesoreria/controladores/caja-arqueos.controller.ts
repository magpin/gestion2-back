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
  AbrirArqueoDto,
  CerrarArqueoDto,
  ListarArqueosDto,
} from '../dto/caja-arqueo.dto';
import { CajaArqueoService } from '../servicios/caja-arqueo.service';

/**
 * El cuadre diario de una caja. No hay `PATCH` ni `DELETE`: un arqueo
 * cerrado queda congelado, igual que un movimiento — se corrige con un
 * arqueo nuevo, no editando el viejo.
 */
@Controller('cajas/:id/arqueos')
@ExigeEmpresa()
export class CajaArqueosController {
  constructor(private readonly arqueos: CajaArqueoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cajaId: string,
    @Query() q: ListarArqueosDto,
  ) {
    return this.arqueos.listar(ctx, cajaId, q);
  }

  /** Abre el arqueo del día. Rechaza si esta caja ya tiene uno abierto. */
  @Roles('CAJA', 'DIRECTOR')
  @Post('abrir')
  abrir(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cajaId: string,
    @Body() dto: AbrirArqueoDto,
  ) {
    return this.arqueos.abrir(ctx, cajaId, dto);
  }

  /** Cierra el arqueo abierto de esta caja. Ajusta si hay diferencia. */
  @Roles('CAJA', 'DIRECTOR')
  @Post('cerrar')
  cerrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cajaId: string,
    @Body() dto: CerrarArqueoDto,
  ) {
    return this.arqueos.cerrar(ctx, cajaId, dto);
  }
}
