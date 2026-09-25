import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CargarVentasLeidasDto, DescartarLecturaDto } from '../dto/lectura.dto';
import { CargaVentasHistoricasService } from '../servicios/carga-ventas-historicas.service';
import { DocumentoService } from '../servicios/documento.service';

/**
 * Las facturas de venta del sistema anterior que María leyó (fase 11 de
 * `docs/planes/maria-facturas-y-errores.md`).
 *
 * **Director y contador**, los mismos de `POST /facturas-historicas`: cargar el
 * histórico es armar la cartera con la que arranca la empresa, no facturar.
 * Que las haya leído María no le da a nadie un permiso que no tiene.
 */
@Controller('ventas-historicas-leidas')
@ExigeEmpresa()
export class VentasHistoricasLeidasController {
  constructor(
    private readonly carga: CargaVentasHistoricasService,
    private readonly documentos: DocumentoService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.carga.listar(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Get(':id')
  ver(@ActorEmpresa() ctx: CtxEmpresa, @Param('id', ParseUUIDPipe) id: string) {
    return this.carga.ver(ctx, id);
  }

  /**
   * Carga las elegidas. Todas o ninguna: si una tiene un problema —ya está,
   * choca con la resolución—, no entra ninguna y la respuesta dice cuál y por
   * qué, igual que el Excel.
   */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/cargar')
  @HttpCode(HttpStatus.OK)
  cargar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CargarVentasLeidasDto,
  ) {
    return this.carga.cargar(ctx, id, dto.facturas);
  }

  /** La deja sin cargar, con el motivo. Solo si no se cargó ninguna. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post(':id/descartar')
  descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DescartarLecturaDto,
  ) {
    return this.documentos.descartar(ctx, id, 'VENTA_HISTORICA', dto.motivo);
  }
}
