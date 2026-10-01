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
  AnularMovimientoConceptoDto,
  CrearMovimientoConceptoDto,
  GmfPrevistoDto,
  ListarMovimientosConceptoDto,
} from '../dto/movimiento-concepto.dto';
import { MovimientoConceptoService } from '../servicios/movimiento-concepto.service';

/**
 * Ingresos y egresos sin factura, elegidos por concepto. Registrarlos y
 * anularlos lo hacen los mismos que mueven la caja: CAJA y DIRECTOR.
 */
@Controller()
@ExigeEmpresa()
export class MovimientosConceptoController {
  constructor(private readonly movimientos: MovimientoConceptoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get('movimientos-concepto')
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: ListarMovimientosConceptoDto,
  ) {
    return this.movimientos.listar(ctx, q);
  }

  @Roles('CAJA', 'DIRECTOR')
  @Post('movimientos-concepto')
  crear(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CrearMovimientoConceptoDto,
  ) {
    return this.movimientos.registrarManual(ctx, {
      direccion: dto.direccion,
      medio: dto.medio,
      cajaId: dto.cajaId,
      cuentaBancariaId: dto.cuentaBancariaId,
      fecha: dto.fecha,
      terceroId: dto.terceroId ?? null,
      detalle: dto.detalle,
      lineas: dto.lineas ?? [
        { conceptoId: dto.conceptoId!, valor: dto.valor! },
      ],
      retencion: dto.retencion ?? null,
    });
  }

  /** Solo los hechos a mano: los de un recibo o un comprobante se anulan con su documento. */
  @Roles('CAJA', 'DIRECTOR')
  @Post('movimientos-concepto/:id/anular')
  async anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularMovimientoConceptoDto,
  ) {
    return this.movimientos.anularManual(ctx, id, dto.motivo);
  }

  /** Cuánto 4×1000 cobraría el banco por esta salida. */
  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'COMPRAS', 'CONSULTA')
  @Get('tesoreria/gmf-previsto')
  gmfPrevisto(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: GmfPrevistoDto) {
    return this.movimientos.gmfPrevisto(ctx, q.cuentaBancariaId, q.valor);
  }
}
