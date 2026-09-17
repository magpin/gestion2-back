import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActualizarReglaExtractoDto,
  CrearReglaExtractoDto,
} from '../dto/extracto.dto';
import { ExtractoReglaService } from '../servicios/extracto-regla.service';

/** Las reglas que reconocen el 4×1000, las comisiones y demás en el extracto. */
@Controller('extracto-reglas')
@ExigeEmpresa()
export class ExtractoReglasController {
  constructor(private readonly reglas: ExtractoReglaService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.reglas.listar(ctx);
  }

  @Roles('CONTADOR', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearReglaExtractoDto) {
    return this.reglas.crear(ctx, dto);
  }

  @Roles('CONTADOR', 'DIRECTOR')
  @Patch(':id')
  actualizar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarReglaExtractoDto,
  ) {
    return this.reglas.actualizar(ctx, id, dto);
  }
}
