import {
  Body,
  Controller,
  Get,
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
  ConciliarManualDto,
} from '../dto/extracto.dto';
import { ExtractoService } from '../servicios/extracto.service';

/**
 * Un extracto puntual, referenciado por su propio id — a diferencia de
 * `ExtractosController` (`cuentas-bancarias/:id/extractos`), que lista y
 * crea en el contexto de una cuenta.
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

  /** Aparea por (fecha, valor) exacto; deja sin tocar el caso ambiguo. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('conciliar-automatico')
  conciliarAutomatico(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.extractos.conciliarAutomatico(ctx, id);
  }

  /** Aparea a mano lo que el automático dejó sin tocar. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('conciliar-manual')
  conciliarManual(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConciliarManualDto,
  ) {
    return this.extractos.conciliarManual(ctx, id, dto);
  }

  /** Exige que cuadren las dos cuentas de la conciliación; rechaza con el detalle si no. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('cerrar')
  cerrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.extractos.cerrar(ctx, id);
  }
}
