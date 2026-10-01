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
  AnularReciboCajaDto,
  CrearCruceCarteraDto,
  CrearReciboCajaDto,
  ListarRecibosCajaDto,
} from '../dto/recibo-caja.dto';
import { DevolverAnticipoDto } from '../../../common/dto/devolucion.dto';
import { ResumenMesDto } from '../../../common/dto/mes.dto';
import { AnticiposClienteService } from '../servicios/anticipos-cliente.service';
import { CruceCarteraService } from '../servicios/cruce-cartera.service';
import { ReciboCajaService } from '../servicios/recibo-caja.service';

/**
 * Ingresos → Cobros: lo que deben los clientes y los recibos de caja.
 *
 * Mirar la cartera lo necesita quien vende, quien cobra y quien lleva la
 * contabilidad. Cobrar y anular un recibo son los mismos roles que hoy cobran
 * y devuelven un cobro desde la factura: CAJA y DIRECTOR.
 */
@Controller()
@ExigeEmpresa()
export class CobrosController {
  constructor(
    private readonly recibos: ReciboCajaService,
    private readonly cruces: CruceCarteraService,
    private readonly anticipos: AnticiposClienteService,
  ) {}

  /** Los anticipos de todos los clientes que todavía tienen algo por aplicar (PC19). */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/anticipos')
  anticiposPendientes(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.anticipos.pendientes(ctx);
  }

  /** Un anticipo con sus productos: con esto se llena la factura que lo aplica. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/anticipos/:id')
  anticipo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.anticipos.detalle(ctx, id);
  }

  /** Lo que les quedó a favor a los clientes por notas crédito sobre facturas pagadas (E1). */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/saldos-a-favor')
  saldosAFavor(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.anticipos.saldosAFavor(ctx);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('cartera/anticipos/:id/devolver')
  devolverAnticipo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverAnticipoDto,
  ) {
    return this.anticipos.devolver(ctx, id, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('cartera/anticipos/devoluciones/:id/anular')
  anularDevolucion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularReciboCajaDto,
  ) {
    return this.anticipos.anularDevolucion(ctx, id, dto.motivo);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/por-cobrar')
  porCobrar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.recibos.porCobrar(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/clientes/:terceroId/facturas')
  facturasDe(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('terceroId', ParseUUIDPipe) terceroId: string,
  ) {
    return this.recibos.facturasDe(ctx, terceroId);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('recibos-caja')
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarRecibosCajaDto) {
    return this.recibos.listar(ctx, q);
  }

  /** Lo cobrado en el mes por cada caja y cuenta. Antes de `:id`, para que no la confunda. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('recibos-caja/resumen')
  resumen(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ResumenMesDto) {
    return this.recibos.resumen(ctx, q.mes);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('recibos-caja/:id')
  obtener(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recibos.obtener(ctx, id);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('recibos-caja')
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearReciboCajaDto) {
    return this.recibos.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('recibos-caja/:id/anular')
  anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularReciboCajaDto,
  ) {
    return this.recibos.anular(ctx, id, dto.motivo);
  }

  /** Lo que el cliente tiene para aplicar: anticipos con saldo y saldos a favor. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/clientes/:terceroId/disponibles')
  disponibles(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('terceroId', ParseUUIDPipe) terceroId: string,
  ) {
    return this.cruces.disponiblesDe(ctx, terceroId);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'VENTAS', 'CONSULTA')
  @Get('cartera/cruces')
  listarCruces(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: ListarRecibosCajaDto,
  ) {
    return this.cruces.listar(ctx, q.terceroId);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('cartera/cruces')
  crearCruce(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearCruceCarteraDto,
  ) {
    return this.cruces.crear(ctx, dto);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('cartera/cruces/:id/anular')
  anularCruce(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularReciboCajaDto,
  ) {
    return this.cruces.anular(ctx, id, dto.motivo);
  }
}
