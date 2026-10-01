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
  Put,
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
  CentroDeUsuarioDto,
  CrearAuxiliarDto,
  CrearCentroCostoDto,
  CrearCuentaEmpresaDto,
  EditarCentroCostoDto,
  EditarCuentaEmpresaDto,
  FijarManejoCentrosDto,
  GuardarRepartoDto,
  ListarCentrosCostoDto,
  ListarCuentasEmpresaDto,
  SiguienteAuxiliarDto,
} from '../dto/plan-cuentas.dto';
import { CentrosCostoService } from '../servicios/centros-costo.service';
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
  constructor(
    private readonly plan: PlanCuentasService,
    private readonly centrosCosto: CentrosCostoService,
  ) {}

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

  // Van antes de `:id` para que 'centros' no entre como si fuera un UUID.
  @Get('centros-costo')
  centros(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarCentrosCostoDto) {
    return this.centrosCosto.listar(ctx, q.soloActivos === 'true');
  }

  /** Si la empresa maneja centros de costo. */
  @Get('centros-costo/manejo')
  async manejoCentros(@ActorEmpresa() ctx: CtxEmpresa) {
    return { activo: await this.centrosCosto.maneja(ctx) };
  }

  /** Encender marca las cuentas 4–7 con «exige centro»; apagar las desmarca. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/manejo')
  @HttpCode(HttpStatus.NO_CONTENT)
  async fijarManejoCentros(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FijarManejoCentrosDto,
  ): Promise<void> {
    await this.centrosCosto.fijarManejo(ctx, dto.activo);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/desde-sedes')
  @HttpCode(HttpStatus.OK)
  crearCentrosDesdeSedes(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.centrosCosto.crearDesdeSedes(ctx);
  }

  /** El centro del usuario en sesión: cada uno elige el suyo. */
  @Get('centros-costo/mio')
  async miCentro(@ActorEmpresa() ctx: CtxEmpresa) {
    return {
      centroCostoId: await this.centrosCosto.deUsuario(ctx, ctx.usuarioId),
    };
  }

  @Put('centros-costo/mio')
  @HttpCode(HttpStatus.NO_CONTENT)
  async fijarMiCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CentroDeUsuarioDto,
  ): Promise<void> {
    await this.centrosCosto.fijarDeUsuario(
      ctx,
      ctx.usuarioId,
      dto.centroCostoId,
    );
  }

  @Get('centros-costo/usuarios/:usuarioId')
  async centroDeUsuario(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return {
      centroCostoId: await this.centrosCosto.deUsuario(ctx, usuarioId),
    };
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Put('centros-costo/usuarios/:usuarioId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async fijarCentroDeUsuario(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
    @Body() dto: CentroDeUsuarioDto,
  ): Promise<void> {
    await this.centrosCosto.fijarDeUsuario(ctx, usuarioId, dto.centroCostoId);
  }

  // Repartos: un gasto común entre varios centros por porcentajes (fase 8).
  @Get('centros-costo/repartos')
  repartos(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.centrosCosto.listarRepartos(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/repartos')
  crearReparto(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: GuardarRepartoDto,
  ) {
    return this.centrosCosto.crearReparto(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Put('centros-costo/repartos/:id')
  editarReparto(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GuardarRepartoDto,
  ) {
    return this.centrosCosto.editarReparto(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/repartos/:id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivarReparto(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.centrosCosto.fijarRepartoActivo(ctx, id, false);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/repartos/:id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activarReparto(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.centrosCosto.fijarRepartoActivo(ctx, id, true);
  }

  /** El centro que el sistema propone para un documento nuevo (D3). */
  @Get('centros-costo/propuesto')
  async centroPropuesto(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('sedeId', new ParseUUIDPipe({ optional: true })) sedeId?: string,
  ) {
    return {
      centroCostoId: await this.centrosCosto.propuesto(ctx, { sedeId }),
    };
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo')
  crearCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearCentroCostoDto,
  ) {
    return this.centrosCosto.crear(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Patch('centros-costo/:id')
  editarCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCentroCostoDto,
  ) {
    return this.centrosCosto.editar(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/:id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivarCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.centrosCosto.desactivar(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('centros-costo/:id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activarCentro(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.centrosCosto.activar(ctx, id);
  }

  /** Crea solo lo que el usuario confirmó de la sugerencia. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('aplicar-sugerencia')
  @HttpCode(HttpStatus.OK)
  aplicar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AplicarSugerenciaDto) {
    return this.plan.aplicar(ctx, dto);
  }

  /**
   * «+ Crear cuenta auxiliar» desde un formulario: la caja, el banco, el
   * producto, el concepto. Además del director y el contador, quien puede
   * crear ese registro, y solo bajo la madre de su contexto: eso lo revisa el
   * servicio (`madrePermitida`). Devuelve la cuenta como `listar`.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'INVENTARIO', 'COMPRAS')
  @Post('auxiliar')
  crearAuxiliar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearAuxiliarDto,
  ) {
    return this.plan.crearAuxiliar(ctx, dto);
  }

  /** El código que saldría bajo una madre, para mostrarlo antes de guardar. */
  @Get('siguiente')
  siguiente(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: SiguienteAuxiliarDto) {
    return this.plan.siguiente(ctx, q.madre);
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

  /** La vuelve a ofrecer. Si su madre está inactiva, primero la madre. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.plan.activar(ctx, id);
  }
}
