import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  AgregarLineaExtractoDto,
  CompletarGrupoDto,
  ConciliarDto,
  NotaLineaDto,
  RegistrarDesdeExtractoDto,
} from '../dto/extracto.dto';
import { ExtractoService } from '../servicios/extracto.service';

/**
 * Un extracto puntual, referenciado por su propio id — a diferencia de
 * `ExtractosController` (`cuentas-bancarias/:id/extractos`), que lista, crea
 * e importa en el contexto de una cuenta.
 *
 * El sistema propone (`GET propuestas`) y una persona confirma (`conciliar`,
 * `registrar`, `completar`). Nada acá concilia solo.
 */
@Controller('extractos/:id')
@ExigeEmpresa()
export class ExtractoController {
  constructor(private readonly extractos: ExtractoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.extractos.porId(ctx, id);
  }

  @Roles('CONTADOR', 'DIRECTOR')
  @Post('lineas')
  agregarLinea(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgregarLineaExtractoDto,
  ) {
    return this.extractos.agregarLinea(ctx, id, dto);
  }

  /** Qué cruza con qué, calculado en el momento. No escribe nada. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get('propuestas')
  propuestas(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.extractos.propuestas(ctx, id);
  }

  /** Confirma uno o varios cruces que cuadran al centavo. Todos o ninguno. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('conciliar')
  @HttpCode(200)
  conciliar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConciliarDto,
  ) {
    return this.extractos.conciliar(ctx, id, dto);
  }

  @Roles('CONTADOR', 'DIRECTOR')
  @Post('grupos/:grupoId/deshacer')
  @HttpCode(204)
  deshacer(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('grupoId', ParseUUIDPipe) grupoId: string,
  ) {
    return this.extractos.deshacer(ctx, id, grupoId);
  }

  /** Registra en el libro lo que el banco cobró o abonó solo, y lo cruza. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('registrar')
  registrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarDesdeExtractoDto,
  ) {
    return this.extractos.registrar(ctx, id, dto);
  }

  /** Registra la diferencia de un cruce que no cuadra, y lo cruza completo. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('completar')
  completar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompletarGrupoDto,
  ) {
    return this.extractos.completar(ctx, id, dto);
  }

  /** Error del banco: la línea queda sin cruzar, con el porqué. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('lineas/:lineaId/nota')
  @HttpCode(204)
  anotarLinea(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineaId', ParseUUIDPipe) lineaId: string,
    @Body() dto: NotaLineaDto,
  ) {
    return this.extractos.anotarLinea(ctx, id, lineaId, dto);
  }

  /** Exige que toda línea esté explicada y que cuadren las dos cuentas; rechaza con el detalle si no. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('cerrar')
  cerrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.extractos.cerrar(ctx, id);
  }
}
