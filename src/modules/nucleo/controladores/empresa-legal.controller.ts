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
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  AbrirActividadDto,
  AbrirResponsabilidadRutDto,
  AbrirMatriculaDto,
  AbrirRegimenDto,
  AbrirRepresentanteDto,
  CerrarVigenciaDto,
  EditarConfiguracionContableDto,
  GuardarHechosOperativosDto,
  TarifaIcaDto,
} from '../dto/empresa-legal.dto';
import { EmpresaLegalService } from '../servicios/empresa-legal.service';

/**
 * Las condiciones legales de la empresa. Nada de esto se edita: se cierra lo
 * vigente y se abre lo nuevo, porque hay que poder responder qué regía en una
 * fecha pasada.
 *
 * Por eso los verbos son `abrir` y `cerrar`, y no `crear` y `editar`.
 */
@Controller('empresa-legal')
@ExigeEmpresa()
export class EmpresaLegalController {
  constructor(private readonly legal: EmpresaLegalService) {}

  // --- Actividad económica (CIIU + tarifa de ICA) -----------------------------

  @Get('actividades')
  listarActividades(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('vigentes') vigentes?: string,
  ) {
    return this.legal.listarActividades(ctx, vigentes !== 'false');
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('actividades')
  abrirActividad(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: AbrirActividadDto,
  ) {
    return this.legal.abrirActividad(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('actividades/:id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrarActividad(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarVigenciaDto,
  ): Promise<void> {
    await this.legal.cerrarActividad(ctx, id, dto.fechaFin);
  }

  /** Completa la tarifa de ICA de una actividad que se registró sin ella. */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('actividades/:id/tarifa-ica')
  @HttpCode(HttpStatus.NO_CONTENT)
  async completarTarifaIca(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TarifaIcaDto,
  ): Promise<void> {
    await this.legal.completarTarifaIca(ctx, id, dto.tarifaIcaPorMil);
  }

  // --- Régimen tributario ----------------------------------------------------

  @Get('responsabilidades-rut')
  responsabilidadesRut(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('vigentes') vigentes?: string,
  ) {
    return this.legal.listarResponsabilidadesRut(ctx, vigentes !== 'false');
  }

  /** Casilla 53 del RUT tal como la imprime la DIAN. Historica: no se edita. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('responsabilidades-rut')
  abrirResponsabilidadRut(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: AbrirResponsabilidadRutDto,
  ) {
    return this.legal.abrirResponsabilidadRut(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('responsabilidades-rut/:id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrarResponsabilidadRut(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarVigenciaDto,
  ): Promise<void> {
    await this.legal.cerrarResponsabilidadRut(ctx, id, dto.fechaFin);
  }

  @Get('regimenes')
  listarRegimenes(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('vigentes') vigentes?: string,
  ) {
    return this.legal.listarRegimenes(ctx, vigentes !== 'false');
  }

  /**
   * Qué condiciones regían una fecha dada. Es la consulta que decide si una
   * factura de esa fecha lleva IVA.
   */
  @Get('regimenes/vigente')
  regimenVigente(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('fecha') fecha?: string,
  ) {
    return this.legal.regimenVigente(
      ctx,
      fecha ?? new Date().toISOString().slice(0, 10),
    );
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('regimenes')
  abrirRegimen(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AbrirRegimenDto) {
    return this.legal.abrirRegimen(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('regimenes/:id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrarRegimen(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarVigenciaDto,
  ): Promise<void> {
    await this.legal.cerrarRegimen(ctx, id, dto.fechaFin);
  }

  // --- Representante legal ---------------------------------------------------

  @Get('representantes')
  listarRepresentantes(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('vigentes') vigentes?: string,
  ) {
    return this.legal.listarRepresentantes(ctx, vigentes !== 'false');
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @Post('representantes')
  abrirRepresentante(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: AbrirRepresentanteDto,
  ) {
    return this.legal.abrirRepresentante(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @Post('representantes/:id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrarRepresentante(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarVigenciaDto,
  ): Promise<void> {
    await this.legal.cerrarRepresentante(ctx, id, dto.fechaFin);
  }

  // --- Hechos de la operación ------------------------------------------------
  // Cuatro respuestas de sí o no que ningún documento trae y que deciden 24
  // cuentas del plan. Se leen y se guardan enteras: son casillas de una misma
  // pregunta, y desmarcar una significa tanto como marcarla.

  @Get('hechos-operativos')
  hechosOperativos(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.legal.hechosOperativos(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Put('hechos-operativos')
  guardarHechosOperativos(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: GuardarHechosOperativosDto,
  ) {
    return this.legal.guardarHechosOperativos(ctx, dto);
  }

  // --- Matrícula mercantil ---------------------------------------------------

  @Get('matriculas')
  listarMatriculas(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('vigentes') vigentes?: string,
  ) {
    return this.legal.listarMatriculas(ctx, vigentes !== 'false');
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @Post('matriculas')
  abrirMatricula(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: AbrirMatriculaDto,
  ) {
    return this.legal.abrirMatricula(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @Post('matriculas/:id/cerrar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cerrarMatricula(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarVigenciaDto,
  ): Promise<void> {
    await this.legal.cerrarMatricula(ctx, id, dto.fechaFin);
  }

  // --- Configuración contable ------------------------------------------------

  @Get('configuracion-contable')
  configuracion(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.legal.configuracionContable(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Put('configuracion-contable')
  editarConfiguracion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: EditarConfiguracionContableDto,
  ) {
    return this.legal.editarConfiguracionContable(ctx, dto);
  }
}
