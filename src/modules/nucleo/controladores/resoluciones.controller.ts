import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  CrearResolucionDto,
  GuardarCredencialDto,
} from '../dto/resolucion.dto';
import { ResolucionService } from '../servicios/resolucion.service';

/**
 * Resoluciones de numeración y credenciales de facturación electrónica.
 *
 * Acá vive la autorización para emitir. La transmisión del XML a la DIAN, el
 * CUFE/CUDE y los acuses son del módulo `dian`, que no existe todavía.
 */
@Controller('resoluciones')
@ExigeEmpresa()
export class ResolucionesController {
  constructor(private readonly resoluciones: ResolucionService) {}

  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.resoluciones.listar(ctx);
  }

  /**
   * Cuántos números quedan y cuándo vence cada resolución activa. Pedirle una
   * nueva a la DIAN toma días: quedarse sin numeración es quedarse sin facturar.
   */
  @Get('disponibilidad')
  disponibilidad(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.resoluciones.disponibilidad(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearResolucionDto) {
    return this.resoluciones.crear(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.resoluciones.desactivar(ctx, id);
  }

  // --- Credenciales DIAN -----------------------------------------------------

  /** Estado de las credenciales. Nunca su contenido: los secretos no salen por la API. */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Get('credenciales')
  estadoCredenciales(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.resoluciones.estadoCredenciales(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @Put('credenciales')
  @HttpCode(HttpStatus.NO_CONTENT)
  async guardarCredenciales(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: GuardarCredencialDto,
  ): Promise<void> {
    await this.resoluciones.guardarCredenciales(ctx, dto);
  }
}
