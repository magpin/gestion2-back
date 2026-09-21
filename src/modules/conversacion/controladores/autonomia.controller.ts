import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import { ROLES, type CtxEmpresa } from '../../../common/ctx';
import { CambiarReglaDto, PausarAutonomiaDto } from '../dto/conversacion.dto';
import { AutonomiaService } from '../servicios/autonomia.service';

/**
 * Hasta dónde llega el asistente (paso 8, `docs/planes/asistente-autonomia.md`).
 *
 * **Todos los roles ven** las reglas, sus aciertos y lo que hizo solo: lo que
 * se registra sin preguntar no puede pasar desapercibido para nadie de la
 * empresa. **Solo DIRECTOR las cambia**, y eso lo mira el servicio.
 */
@Controller('conversacion/autonomia')
@ExigeEmpresa()
@Roles(...ROLES)
export class AutonomiaController {
  constructor(private readonly autonomia: AutonomiaService) {}

  @Get()
  estado(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.autonomia.estado(ctx);
  }

  /** Lo que hizo solo y lo que apartó en un día: hoy, o `?fecha=aaaa-mm-dd`. */
  @Get('resumen')
  resumen(@ActorEmpresa() ctx: CtxEmpresa, @Query('fecha') fecha?: string) {
    return this.autonomia.resumen(
      ctx,
      fecha !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
        ? fecha
        : undefined,
    );
  }

  @Post('reglas')
  @HttpCode(200)
  cambiarRegla(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CambiarReglaDto) {
    return this.autonomia.cambiarRegla(
      ctx,
      dto.accion,
      dto.modo,
      dto.limite ?? null,
    );
  }

  @Post('pausa')
  @HttpCode(200)
  pausar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: PausarAutonomiaDto) {
    return this.autonomia.pausar(ctx, dto.pausada);
  }
}
