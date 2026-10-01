import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { ResponderIcaDto, ResponderImpuestoDto } from '../dto/impuestos.dto';
import { ImpuestosEmpresaService } from '../servicios/impuestos-empresa.service';

/**
 * El paso «Impuestos» de la configuración: preguntas en lenguaje de persona que
 * terminan en la casilla 53 del RUT, el ICA por municipio y el resumen de lo
 * que eso significa (plan motor de retenciones, Fase 0, §0.7).
 */
@Controller('empresa-impuestos')
@ExigeEmpresa()
export class ImpuestosController {
  constructor(private readonly impuestos: ImpuestosEmpresaService) {}

  @Get()
  estado(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.estado(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Put('respuestas')
  responder(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: ResponderImpuestoDto,
  ) {
    return this.impuestos.responder(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Put('ica/:municipio')
  responderIca(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('municipio') municipio: string,
    @Body() dto: ResponderIcaDto,
  ) {
    return this.impuestos.responderIca(ctx, municipio, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('confirmar')
  confirmar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.impuestos.confirmar(ctx);
  }
}
