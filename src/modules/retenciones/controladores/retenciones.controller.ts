import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  DescartarDiferenciaDto,
  NuevaResidenciaDto,
  NuevoIcaTerceroDto,
  NuevoPerfilDto,
  PrevisualizarRetencionDto,
  RechazarPropuestaPerfilDto,
} from '../dto/retencion.dto';
import { RetencionesApi } from '../retenciones.api';
import { MotorRentaService } from '../servicios/motor-renta.service';
import { PerfilTerceroService } from '../servicios/perfil-tercero.service';
import { RecalculoService } from '../servicios/recalculo.service';
import { RetencionService } from '../servicios/retencion.service';

/**
 * Los conceptos de retención de la empresa, la ley y la UVT, **solo para
 * consultar**. Nada de esto se carga a mano: los enlaces a las cuentas los crea
 * el sistema y las tarifas y la UVT son de la ley (plan motor de retenciones,
 * Fase 0).
 */
@Controller('retenciones')
@ExigeEmpresa()
export class RetencionesController {
  constructor(
    private readonly retenciones: RetencionService,
    private readonly api: RetencionesApi,
    private readonly motor: MotorRentaService,
    private readonly perfiles: PerfilTerceroService,
    private readonly recalculo: RecalculoService,
  ) {}

  /**
   * Por qué se retuvo lo que se retuvo en un documento: las guardas, el
   * concepto y de dónde salió, la base, el mínimo, la tarifa y la norma.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('documentos/:tipo/:id')
  explicacion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('tipo') tipo: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.motor.deDocumento(ctx, tipo.toUpperCase(), id);
  }

  /** Los datos tributarios de un tercero, con toda su historia. */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('terceros/:id/perfil')
  perfil(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.perfiles.historia(ctx, id);
  }

  /** Una versión nueva desde una fecha. Nunca pisa la anterior (R-D8). */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('terceros/:id/perfil')
  nuevoPerfil(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NuevoPerfilDto,
  ) {
    return this.perfiles.nuevaVersion(ctx, id, dto);
  }

  /** El ICA de la empresa por municipio: agente, base, tarifa, si acumula. */
  /** La residencia fiscal de un proveedor del exterior (Fase 8, §8.15). */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get('terceros/:id/residencia')
  residencia(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.perfiles.residencia(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('terceros/:id/residencia')
  nuevaResidencia(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NuevaResidenciaDto,
  ) {
    return this.perfiles.nuevaResidencia(ctx, id, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('ica')
  icaEmpresa(@ActorEmpresa() ctx: CtxEmpresa, @Query('anio') anio?: string) {
    return this.perfiles.icaDeEmpresa(
      ctx,
      anio === undefined ? new Date().getFullYear() : Number(anio),
    );
  }

  /** El ICA de un proveedor en cada municipio, con historia. */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('terceros/:id/ica')
  icaTercero(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.perfiles.icaDeTercero(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('terceros/:id/ica')
  nuevoIcaTercero(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NuevoIcaTerceroDto,
  ) {
    return this.perfiles.nuevoIcaTercero(ctx, id, dto);
  }

  /** Lo que el motor aprendió de lo que confirmaron: proveedor → concepto. */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('aprendido')
  aprendido(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.perfiles.aprendido(ctx);
  }

  /** Por fuente: cuántas veces se aceptó lo propuesto tal cual y cuántas se cambió. */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('aciertos')
  aciertos(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.motor.aciertos(ctx);
  }

  /**
   * Las diferencias que dejó un recálculo por cambio de norma (Fase 6, §6.3):
   * las pendientes primero. Ajustarlas es de quien responde por la
   * declaración.
   */
  /**
   * Lo que las facturas leídas dicen de los proveedores y no coincide con su
   * perfil (Fase 8, §8.8): pendientes de que una persona lo apruebe.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get('propuestas-perfil')
  propuestasPerfil(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query('terceroId', new ParseUUIDPipe({ optional: true }))
    terceroId?: string,
  ) {
    return this.perfiles.propuestas(ctx, terceroId);
  }

  /** Aprobar abre la versión nueva del perfil (R-D8: DIRECTOR y CONTADOR). */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('propuestas-perfil/:id/aprobar')
  @HttpCode(HttpStatus.NO_CONTENT)
  aprobarPropuestaPerfil(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.perfiles.aprobarPropuesta(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('propuestas-perfil/:id/rechazar')
  @HttpCode(HttpStatus.NO_CONTENT)
  rechazarPropuestaPerfil(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarPropuestaPerfilDto,
  ) {
    return this.perfiles.rechazarPropuesta(ctx, id, dto.motivo);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Get('diferencias')
  diferencias(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.recalculo.listar(ctx);
  }

  /** El asiento que corregiría la diferencia, sin registrar nada. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Get('diferencias/:id/ajuste')
  verAjuste(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recalculo.verAjuste(ctx, id);
  }

  /** Una persona aprueba el ajuste: se asienta y entra la retención que corrige. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('diferencias/:id/ajuste')
  registrarAjuste(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recalculo.registrarAjuste(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('diferencias/:id/descartar')
  @HttpCode(HttpStatus.NO_CONTENT)
  descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DescartarDiferenciaDto,
  ) {
    return this.recalculo.descartar(ctx, id, dto.motivo);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post('aprendido/:id/quitar')
  @HttpCode(HttpStatus.NO_CONTENT)
  quitarAprendido(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.perfiles.quitarAprendido(ctx, id);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('conceptos')
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query('anio') anio?: string) {
    return this.retenciones.listar(
      ctx,
      anio === undefined ? undefined : Number(anio),
    );
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('uvt')
  listarUvt(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.retenciones.listarUvt(ctx);
  }

  /** Los conceptos de la ley con todas sus vigencias, las pasadas incluidas. */
  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get('ley')
  ley(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.retenciones.ley(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'COMPRAS', 'VENTAS')
  @Get('previsualizar')
  previsualizar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: PrevisualizarRetencionDto,
  ) {
    return (
      this.api
        .calcular(ctx, {
          conceptoId: q.conceptoId,
          base: q.base,
          fecha: q.fecha,
          declaranteRenta: q.declaranteRenta ?? true,
          tipoPersona: q.tipoPersona,
          ivaDocumento: q.iva,
          lado: q.lado,
        })
        // `null` no viaja bien como cuerpo: se dice con todas las letras.
        .then((r) =>
          r === null
            ? { retiene: false as const }
            : { retiene: true as const, ...r },
        )
    );
  }
}
