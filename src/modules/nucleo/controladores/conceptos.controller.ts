import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  CrearConceptoDto,
  EditarConceptoDto,
  ListarConceptosDto,
} from '../dto/conceptos.dto';
import { ConceptosService } from '../servicios/conceptos.service';

/**
 * Los conceptos de ingreso y egreso de la empresa.
 *
 * Leerlos lo necesita quien registra —caja, compras, ventas— para elegir uno.
 * Crearlos, cambiarles la cuenta o desactivarlos es del director y del
 * contador: un concepto mal colgado desordena el estado de resultados.
 */
@Controller('conceptos')
@ExigeEmpresa()
export class ConceptosController {
  constructor(private readonly conceptos: ConceptosService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA', 'COMPRAS', 'VENTAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarConceptosDto) {
    return this.conceptos.listar(ctx, q);
  }

  /** Siembra el catálogo inicial y les busca cuenta a los que no tienen. Idempotente. */
  @Roles('DIRECTOR', 'CONTADOR')
  @Post('preparar')
  preparar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.conceptos.preparar(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearConceptoDto) {
    return this.conceptos.crear(ctx, dto);
  }

  @Roles('DIRECTOR', 'CONTADOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarConceptoDto,
  ) {
    return this.conceptos.editar(ctx, id, dto);
  }
}
