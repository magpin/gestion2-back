import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { BuscarPucDto } from '../dto/catalogo.dto';
import {
  AplicarSugerenciaDto,
  CrearCentroCostoDto,
  CrearCuentaEmpresaDto,
  EditarCentroCostoDto,
  EditarCuentaEmpresaDto,
  ListarCuentasEmpresaDto,
} from '../dto/plan-cuentas.dto';
import { PlanCuentasService } from '../servicios/plan-cuentas.service';

/**
 * El plan de cuentas de la empresa.
 *
 * Leer lo puede cualquiera con acceso a la contabilidad —al digitar una factura
 * hay que ver las cuentas—. Cambiarlo es del director y del contador: una cuenta
 * mal clasificada desordena todos los informes de ahí en adelante.
 */
@Controller('plan-cuentas')
@ExigeEmpresa()
export class PlanCuentasController {
  constructor(private readonly plan: PlanCuentasService) {}

  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarCuentasEmpresaDto) {
    return this.plan.listar(ctx, q);
  }

  /**
   * Qué cuentas necesita esta empresa según lo que ya declaró, y qué no se puede
   * proponer porque falta un dato. No crea nada.
   */
  @Get('sugerencia')
  sugerencia(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.plan.sugerencia(ctx);
  }

  /**
   * El catálogo del Decreto 2650 visto desde esta empresa: cada cuenta viene
   * marcada según le sirva o no, con el motivo cuando no.
   *
   * No filtra, marca. Va acá y no en `/catalogos/puc` porque necesita empresa
   * elegida, y aquel es el catálogo compartido que se lee sin contexto.
   */
  @Get('catalogo')
  catalogo(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: BuscarPucDto) {
    return this.plan.catalogo(ctx, q);
  }

  // Va antes de `:id` para que 'centros' no entre como si fuera un UUID.
  @Get('centros-costo')
  centros(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.plan.centros(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo')
  crearCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearCentroCostoDto,
  ) {
    return this.plan.crearCentro(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Patch('centros-costo/:id')
  editarCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCentroCostoDto,
  ) {
    return this.plan.editarCentro(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/:id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivarCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.plan.desactivarCentro(ctx, id);
  }

  /** Crea solo lo que el usuario confirmó de la sugerencia. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('aplicar-sugerencia')
  @HttpCode(HttpStatus.OK)
  aplicar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AplicarSugerenciaDto) {
    return this.plan.aplicar(ctx, dto);
  }

  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.plan.porId(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCuentaEmpresaDto) {
    return this.plan.crear(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCuentaEmpresaDto,
  ) {
    return this.plan.editar(ctx, id, dto);
  }

  /** No borra: desactiva. Una cuenta con movimiento no se puede quitar. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.plan.desactivar(ctx, id);
  }
}
