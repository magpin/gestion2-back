import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { Publico } from '../../../common/auth/decoradores';
import { hoyEnColombia } from '../../../common/fecha';
import { ConsumoIaApi } from '../../consumo-ia/consumo-ia.api';
import {
  AjustarCuposDto,
  CambiarEstadoDto,
  CambiarPlanDto,
  CrearCuentaDto,
  CrearEmpresaEnCuentaDto,
  CrearUsuarioEnCuentaDto,
  EditarPlanDto,
  RenombrarCuentaDto,
} from '../dto/cuentas.dto';
import { Admin } from '../plataforma.decoradores';
import type { CtxPlataforma } from '../../../common/ctx';
import { PlataformaGuard } from '../plataforma.guard';
import {
  AnuncioDto,
  CambiarSuscripcionDto,
  PausarIaDto,
  PrecioPlanDto,
  RegistrarPagoDto,
} from '../dto/cobros.dto';
import { CobrosService } from '../servicios/cobros.service';
import { CuentasService } from '../servicios/cuentas.service';
import { PanelService } from '../servicios/panel.service';
import {
  NuevaTarifaDto,
  NuevaUvtDto,
  NuevoIcaMunicipioDto,
  NuevaAutorretencionDto,
  RecalcularRetencionesDto,
} from '../dto/ley-retenciones.dto';
import { LeyRetencionesService } from '../servicios/ley-retenciones.service';
import { SistemaService } from '../servicios/sistema.service';

/**
 * La administración del producto.
 *
 * Va bajo `/plataforma` y con guard propio: los guards globales del sistema
 * esperan un token de cliente, y este es de otro ámbito. `@Publico()` los
 * desactiva y `PlataformaGuard` toma su lugar, para todo el controlador.
 *
 * Acá NO se entra: el login es uno solo y vive en `POST /auth/login`, que
 * devuelve `ambito: 'PLATAFORMA'` cuando el correo administra el producto. Este
 * controlador solo recibe tokens ya emitidos.
 *
 * Lo que este controlador NO tiene es tan importante como lo que tiene: no hay
 * un endpoint para entrar a una contabilidad, ni para leer asientos, facturas o
 * terceros, ni el texto de una conversación con el asistente. Administrar el
 * producto y operar una contabilidad son dos cosas distintas, y acá solo vive
 * la primera.
 */
@Controller('plataforma')
@Publico()
@UseGuards(PlataformaGuard)
export class PlataformaController {
  constructor(
    private readonly cuentas: CuentasService,
    private readonly panel: PanelService,
    private readonly consumo: ConsumoIaApi,
    private readonly cobros: CobrosService,
    private readonly sistema: SistemaService,
    private readonly ley: LeyRetencionesService,
  ) {}

  @Get('auth/yo')
  yo(@Admin() admin: CtxPlataforma) {
    return admin;
  }

  // --- Panel ----------------------------------------------------------------

  @Get('inicio')
  inicio() {
    return this.panel.inicio();
  }

  /** Ctrl K: cuentas, empresas por razón social o NIT, y usuarios por correo. */
  @Get('buscar')
  buscar(@Query('q') q?: string) {
    return this.panel.buscar(q ?? '');
  }

  @Get('bitacora')
  bitacora(
    @Query('cuenta') cuenta?: string,
    @Query('admin') admin?: string,
    @Query('accion') accion?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('pagina') pagina?: string,
  ) {
    return this.panel.bitacora({ cuenta, admin, accion, desde, hasta, pagina });
  }

  @Get('planes')
  planes() {
    return this.panel.planes();
  }

  @Patch('planes/:clave')
  editarPlan(
    @Admin() admin: CtxPlataforma,
    @Param('clave') clave: string,
    @Body() dto: EditarPlanDto,
  ) {
    return this.panel.editarPlan(admin, clave, dto);
  }

  /** El precio y el tope de IA (de ejemplo) de un plan. */
  @Patch('planes/:clave/precio')
  editarPrecio(
    @Admin() admin: CtxPlataforma,
    @Param('clave') clave: string,
    @Body() dto: PrecioPlanDto,
  ) {
    return this.panel.editarPrecio(admin, clave, dto);
  }

  // --- Sistema, anuncios y administradores ---------------------------------

  @Get('sistema')
  estadoSistema() {
    return this.sistema.estado();
  }

  /** Apaga el asistente para una cuenta o para todas. */
  @Post('sistema/pausas')
  pausar(@Admin() admin: CtxPlataforma, @Body() dto: PausarIaDto) {
    return this.sistema.pausar(admin, dto);
  }

  @Post('sistema/pausas/:id/reanudar')
  reanudar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sistema.reanudar(admin, id);
  }

  @Get('anuncios')
  anuncios() {
    return this.sistema.anuncios();
  }

  @Post('anuncios')
  publicar(@Admin() admin: CtxPlataforma, @Body() dto: AnuncioDto) {
    return this.sistema.publicar(admin, dto);
  }

  @Post('anuncios/:id/retirar')
  retirar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sistema.retirar(admin, id);
  }

  // --- Ley de retenciones (plan motor de retenciones, Fase 0, §0.8) --------

  @Get('retenciones')
  leyRetenciones() {
    return this.ley.ley();
  }

  /** Nunca edita: cierra la vigencia abierta y abre la nueva. */
  @Post('retenciones/tarifas')
  nuevaTarifa(@Admin() admin: CtxPlataforma, @Body() dto: NuevaTarifaDto) {
    return this.ley.nuevaTarifa(admin, dto);
  }

  @Get('retenciones/ica')
  leyIca() {
    return this.ley.ica();
  }

  /** La ley de ICA de un municipio para un año nuevo, con su acuerdo. */
  @Post('retenciones/ica')
  nuevoIcaMunicipio(
    @Admin() admin: CtxPlataforma,
    @Body() dto: NuevoIcaMunicipioDto,
  ) {
    return this.ley.nuevoIcaMunicipio(admin, dto);
  }

  /** Aciertos del clasificador por fuente, de los últimos 90 días. */
  @Get('retenciones/aciertos')
  aciertosRetenciones() {
    return this.ley.aciertos();
  }

  @Get('retenciones/autorretencion')
  autorretenciones() {
    return this.ley.autorretenciones();
  }

  /** La tarifa de autorretención especial de un CIIU, con su norma. */
  @Post('retenciones/autorretencion')
  nuevaAutorretencion(
    @Admin() admin: CtxPlataforma,
    @Body() dto: NuevaAutorretencionDto,
  ) {
    return this.ley.nuevaAutorretencion(admin, dto);
  }

  @Post('retenciones/uvt')
  nuevaUvt(@Admin() admin: CtxPlataforma, @Body() dto: NuevaUvtDto) {
    return this.ley.nuevaUvt(admin, dto);
  }

  /**
   * Recalcula con la norma que rige hoy y deja las diferencias en cada
   * empresa (Fase 6, §6.3). No toca asientos: los ajustes los aprueba una
   * persona de la empresa (R-D6).
   */
  @Post('retenciones/recalcular')
  recalcularRetenciones(
    @Admin() admin: CtxPlataforma,
    @Body() dto: RecalcularRetencionesDto,
  ) {
    return this.ley.recalcular(admin, dto);
  }

  @Get('retenciones/recalculos')
  recalculos() {
    return this.ley.recalculos();
  }

  /** El reporte de diferencias de un recálculo, de todas las empresas. */
  @Get('retenciones/recalculos/:id')
  recalculo(@Param('id', ParseUUIDPipe) id: string) {
    return this.ley.recalculo(id);
  }

  /** El alta de un administrador no está acá: es por script, en el servidor. */
  @Get('administradores')
  administradores() {
    return this.sistema.administradores();
  }

  @Post('administradores/:id/desactivar')
  desactivarAdmin(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sistema.cambiarAdmin(admin, id, false);
  }

  @Post('administradores/:id/reactivar')
  reactivarAdmin(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sistema.cambiarAdmin(admin, id, true);
  }

  /** La contraseña nueva sale una sola vez, en esta respuesta. */
  @Post('administradores/:id/restablecer')
  restablecerAdmin(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sistema.restablecerAdmin(admin, id);
  }

  // --- Consumo de IA: solo cifras ------------------------------------------

  /** `?desde=&hasta=&cuenta=&empresa=`, como el tablero aparte. */
  @Get('consumo-ia')
  consumoIa(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('cuenta') cuentaId?: string,
    @Query('empresa') empresaId?: string,
  ) {
    return this.consumo.tablero({ desde, hasta, cuentaId, empresaId });
  }

  @Get('consumo-ia/detalle')
  consumoIaDetalle(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('cuenta') cuentaId?: string,
    @Query('empresa') empresaId?: string,
    @Query('categoria') categoria?: string,
    @Query('orden') orden?: string,
    @Query('pagina') pagina?: string,
  ) {
    return this.consumo.detalle({
      desde,
      hasta,
      cuentaId,
      empresaId,
      categoria,
      orden,
      pagina,
    });
  }

  // --- Cuentas --------------------------------------------------------------

  /** `?q=&filtro=&orden=&dir=&pagina=`. */
  @Get('cuentas')
  listar(
    @Query('q') q?: string,
    @Query('filtro') filtro?: string,
    @Query('orden') orden?: string,
    @Query('dir') dir?: string,
    @Query('pagina') pagina?: string,
  ) {
    return this.cuentas.listar({ q, filtro, orden, dir, pagina });
  }

  /** Las cuentas del filtro, todas, en un Excel. */
  @Get('cuentas/exportar')
  async exportar(
    @Res() res: Response,
    @Query('q') q?: string,
    @Query('filtro') filtro?: string,
    @Query('orden') orden?: string,
    @Query('dir') dir?: string,
  ): Promise<void> {
    const xlsx = await this.cuentas.exportar({ q, filtro, orden, dir });
    res
      .status(200)
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader(
        'Content-Disposition',
        `attachment; filename="cuentas-${hoyEnColombia()}.xlsx"`,
      )
      .setHeader('Content-Length', String(xlsx.length))
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .end(xlsx);
  }

  @Get('cuentas/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.cuentas.detalle(id);
  }

  /** Cuenta y su primer usuario. La contraseña, si se generó, sale una vez. */
  @Post('cuentas')
  crear(@Admin() admin: CtxPlataforma, @Body() dto: CrearCuentaDto) {
    return this.cuentas.crearCuenta(admin, dto);
  }

  @Patch('cuentas/:id')
  renombrar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenombrarCuentaDto,
  ) {
    return this.cuentas.renombrar(admin, id, dto.nombre);
  }

  @Patch('cuentas/:id/plan')
  cambiarPlan(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarPlanDto,
  ) {
    return this.cuentas.cambiarPlan(admin, id, dto);
  }

  /** Suspender no borra nada: el cliente deja de emitir hasta que se reactive. */
  @Patch('cuentas/:id/estado')
  cambiarEstado(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarEstadoDto,
  ) {
    return this.cuentas.cambiarEstado(admin, id, dto);
  }

  @Patch('cuentas/:id/cupos')
  ajustarCupos(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AjustarCuposDto,
  ) {
    return this.cuentas.ajustarCupos(admin, id, dto);
  }

  // --- Suscripción ----------------------------------------------------------

  @Get('cuentas/:id/suscripcion')
  suscripcion(@Param('id', ParseUUIDPipe) id: string) {
    return this.cobros.suscripcion(id);
  }

  /** El precio pactado (null vuelve al del plan) y el día de corte. */
  @Patch('cuentas/:id/suscripcion')
  cambiarSuscripcion(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarSuscripcionDto,
  ) {
    return this.cobros.cambiarSuscripcion(admin, id, dto);
  }

  /** Un pago que llegó por fuera del sistema. No se edita ni se borra. */
  @Post('cuentas/:id/pagos')
  registrarPago(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarPagoDto,
  ) {
    return this.cobros.registrarPago(admin, id, dto);
  }

  // --- Dentro de una cuenta -------------------------------------------------

  @Post('cuentas/:id/empresas')
  crearEmpresa(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearEmpresaEnCuentaDto,
  ) {
    return this.cuentas.crearEmpresa(admin, id, dto);
  }

  @Post('cuentas/:id/usuarios')
  crearUsuario(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearUsuarioEnCuentaDto,
  ) {
    return this.cuentas.crearUsuario(admin, id, dto);
  }

  /** La contraseña nueva sale una sola vez, en esta respuesta. */
  @Post('cuentas/:id/usuarios/:usuarioId/restablecer')
  restablecer(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.cuentas.restablecer(admin, id, usuarioId);
  }

  @Post('cuentas/:id/usuarios/:usuarioId/desactivar')
  desactivar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.cuentas.desactivar(admin, id, usuarioId);
  }

  @Post('cuentas/:id/usuarios/:usuarioId/reactivar')
  reactivar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.cuentas.reactivar(admin, id, usuarioId);
  }
}
