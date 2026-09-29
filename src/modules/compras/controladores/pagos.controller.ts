import {
  Body,
  Controller,
  Get,
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
  AnularPagoDto,
  CrearComprobanteEgresoDto,
  CrearCrucePagoDto,
  CrearPagoProgramadoDto,
  FiltroTerceroDto,
  ListarProgramadosDto,
  MarcarPagadoDto,
  ProponerRetencionAnticipoDto,
} from '../dto/pagos.dto';
import { ComprobanteEgresoService } from '../servicios/comprobante-egreso.service';
import { CrucePagoService } from '../servicios/cruce-pago.service';
import { EgresosService } from '../servicios/egresos.service';
import { DevolverAnticipoDto } from '../../../common/dto/devolucion.dto';
import { ResumenMesDto } from '../../../common/dto/mes.dto';
import { AnticiposProveedorService } from '../servicios/anticipos-proveedor.service';
import { PagoProgramadoService } from '../servicios/pago-programado.service';

const LEEN = ['DIRECTOR', 'CONTADOR', 'CAJA', 'COMPRAS', 'CONSULTA'] as const;

/**
 * Egresos → Pagos: lo que se le debe a los proveedores, el comprobante de
 * egreso, los anticipos y los pagos programados.
 *
 * Pagar y anular son los mismos roles que hoy pagan desde la compra: CAJA y
 * DIRECTOR. Programar un pago lo puede también quien compra: es agenda, no
 * mueve plata.
 */
@Controller()
@ExigeEmpresa()
export class PagosController {
  constructor(
    private readonly comprobantes: ComprobanteEgresoService,
    private readonly cruces: CrucePagoService,
    private readonly programados: PagoProgramadoService,
    private readonly egresos: EgresosService,
    private readonly anticipos: AnticiposProveedorService,
  ) {}

  /** Los anticipos a todos los proveedores que todavía no se legalizan (PC19). */
  @Roles(...LEEN)
  @Get('pagos/anticipos')
  anticiposPendientes(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.anticipos.pendientes(ctx);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('pagos/anticipos/:id/devolver')
  devolverAnticipo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverAnticipoDto,
  ) {
    return this.anticipos.devolver(ctx, id, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('pagos/anticipos/devoluciones/:id/anular')
  anularDevolucion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularPagoDto,
  ) {
    return this.anticipos.anularDevolucion(ctx, id, dto.motivo);
  }

  /** Todo lo que salió en el mes (PC12): proveedores, sin factura e impuestos, con el resumen por medio. */
  @Roles(...LEEN)
  @Get('pagos/egresos')
  delMes(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ResumenMesDto) {
    return this.egresos.delMes(ctx, q.mes);
  }

  @Roles(...LEEN)
  @Get('pagos/por-pagar')
  porPagar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.comprobantes.porPagar(ctx);
  }

  @Roles(...LEEN)
  @Get('pagos/proveedores/:terceroId/compras')
  comprasDe(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('terceroId', ParseUUIDPipe) terceroId: string,
  ) {
    return this.comprobantes.comprasDe(ctx, terceroId);
  }

  @Roles(...LEEN)
  @Get('pagos/proveedores/:terceroId/anticipos')
  anticiposDe(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('terceroId', ParseUUIDPipe) terceroId: string,
  ) {
    return this.cruces.anticiposDe(ctx, terceroId);
  }

  @Roles(...LEEN)
  @Get('comprobantes-egreso')
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: FiltroTerceroDto) {
    return this.comprobantes.listar(ctx, q.terceroId);
  }

  /** Lo que el motor retendría del anticipo, sin guardar nada. */
  @Roles('CAJA', 'DIRECTOR', 'CONTADOR')
  @Get('comprobantes-egreso/retencion-anticipo')
  retencionAnticipo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: ProponerRetencionAnticipoDto,
  ) {
    return this.comprobantes.proponerRetencionAnticipo(ctx, q);
  }

  @Roles(...LEEN)
  @Get('comprobantes-egreso/:id')
  obtener(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.comprobantes.obtener(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('comprobantes-egreso')
  crear(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearComprobanteEgresoDto,
  ) {
    return this.comprobantes.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('comprobantes-egreso/:id/anular')
  anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularPagoDto,
  ) {
    return this.comprobantes.anular(ctx, id, dto.motivo);
  }

  @Roles(...LEEN)
  @Get('pagos/cruces')
  listarCruces(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: FiltroTerceroDto) {
    return this.cruces.listar(ctx, q.terceroId);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('pagos/cruces')
  crearCruce(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearCrucePagoDto) {
    return this.cruces.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('pagos/cruces/:id/anular')
  anularCruce(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularPagoDto,
  ) {
    return this.cruces.anular(ctx, id, dto.motivo);
  }

  @Roles(...LEEN)
  @Get('pagos/programados')
  listarProgramados(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: ListarProgramadosDto,
  ) {
    return this.programados.listar(ctx, q.todos !== 'true');
  }

  @Roles('CAJA', 'DIRECTOR', 'COMPRAS', 'CONTADOR')
  @Post('pagos/programados')
  programar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearPagoProgramadoDto,
  ) {
    return this.programados.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('pagos/programados/:id/pagado')
  marcarPagado(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarcarPagadoDto,
  ) {
    return this.programados.marcarPagado(ctx, id, dto);
  }

  @Roles('CAJA', 'DIRECTOR', 'COMPRAS', 'CONTADOR')
  @Post('pagos/programados/:id/cancelar')
  cancelarProgramado(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.programados.cancelar(ctx, id);
  }
}
