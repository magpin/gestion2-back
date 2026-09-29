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

import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import {
  AnularAsientoDto,
  CrearAsientoDto,
  FiltroAsientosDto,
} from '../dto/asiento.dto';
import { AsientoService } from '../servicios/asiento.service';
import { ComprobanteManualService } from '../servicios/comprobante-manual.service';
import { FirmarSoporteDto, PropuestaDto } from '../dto/comprobante-manual.dto';

/**
 * No hay PATCH.
 *
 * Un asiento registrado no se edita: `fn_asiento_inmutable` lo rechaza, y
 * exponer el verbo seria prometer algo que la base niega. La correccion es
 * anular y volver a hacerlo, o un contra-asiento si el periodo ya cerro.
 */
@Controller('asientos')
@ExigeEmpresa()
export class AsientosController {
  constructor(
    private readonly asientos: AsientoService,
    private readonly manual: ComprobanteManualService,
  ) {}

  /** Lo que María propone para el comprobante manual. No guarda nada. */
  @Roles('CONTADOR')
  @Post('propuesta')
  @HttpCode(HttpStatus.OK)
  propuesta(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: PropuestaDto) {
    return this.manual.propuesta(ctx, dto);
  }

  /** Dónde subir el soporte del comprobante manual. */
  @Roles('CONTADOR')
  @Post('soporte/firmar')
  @HttpCode(HttpStatus.OK)
  firmarSoporte(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: FirmarSoporteDto,
  ) {
    return this.manual.firmarSoporte(ctx, dto.tipoMime);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: FiltroAsientosDto) {
    return this.asientos.listar(ctx, q, q);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.asientos.porId(ctx, id);
  }

  /** Solo CONTADOR: `0007` lo define como el unico que escribe asientos manuales. */
  @Roles('CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearAsientoDto) {
    // El manual puede traer su soporte: se guarda en la misma transacción.
    return this.manual.crear(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get(':id/soportes')
  soportes(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.manual.soportes(ctx, id);
  }

  @Roles('CONTADOR')
  @Post(':id/anular')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anular(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularAsientoDto,
  ): Promise<void> {
    await this.asientos.anular(ctx, id, dto.motivo);
  }
}
