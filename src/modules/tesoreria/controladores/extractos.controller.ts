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
import { CrearExtractoDto, ListarExtractosDto } from '../dto/extracto.dto';
import { ExtractoService } from '../servicios/extracto.service';

/**
 * Los extractos de una cuenta bancaria. Las acciones sobre UN extracto ya
 * creado (agregar línea, conciliar, cerrar) viven en `ExtractoController`
 * — ese sí referenciado por su propio id, no por el de la cuenta: un
 * extracto no encadena con el anterior, así que no hay "el abierto de
 * esta cuenta" como en `CajaArqueosController`.
 */
@Controller('cuentas-bancarias/:id/extractos')
@ExigeEmpresa()
export class ExtractosController {
  constructor(private readonly extractos: ExtractoService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Query() q: ListarExtractosDto,
  ) {
    return this.extractos.listar(ctx, cuentaBancariaId, q);
  }

  @Roles('CONTADOR', 'DIRECTOR')
  @Post()
  crear(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) cuentaBancariaId: string,
    @Body() dto: CrearExtractoDto,
  ) {
    return this.extractos.crear(ctx, cuentaBancariaId, dto);
  }
}
