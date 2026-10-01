import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Put,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { FijarCuentaConceptoDto } from '../dto/configuracion.dto';
import { ConfiguracionService } from '../servicios/configuracion.service';
import type { ConceptoInventario } from '../servicios/cuentas-inventario.reglas';

const CONCEPTOS = {
  INVENTARIO: 'INVENTARIO',
  INGRESO: 'INGRESO',
  COSTO_VENTA: 'COSTO_VENTA',
  SOBRANTE: 'SOBRANTE',
  FALTANTE_ASUMIDO: 'FALTANTE_ASUMIDO',
  FALTANTE_COBRABLE: 'FALTANTE_COBRABLE',
} as const satisfies Record<ConceptoInventario, ConceptoInventario>;

/**
 * Las cuentas automáticas de inventario. La pantalla que las muestra vive en
 * el Plan de cuentas («Cuentas automáticas»), no en inventario: quien opera
 * la bodega no tiene por qué verlas.
 */
@Controller('inventario/configuracion')
@ExigeEmpresa()
export class ConfiguracionController {
  constructor(private readonly configuracion: ConfiguracionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO')
  @Get()
  obtener(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.obtener(ctx);
  }

  /** Crea lo que falte. Idempotente. Solo CONTADOR/DIRECTOR: crea cuentas en el plan. */
  @Roles('CONTADOR', 'DIRECTOR', 'ADMIN_TENANT')
  @Post('preparar')
  preparar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.preparar(ctx);
  }

  /** Solo CONTADOR/DIRECTOR: elegir la cuenta es juicio contable. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Put(':concepto')
  fijar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('concepto', new ParseEnumPipe(CONCEPTOS))
    concepto: ConceptoInventario,
    @Body() dto: FijarCuentaConceptoDto,
  ) {
    return this.configuracion.fijar(ctx, concepto, dto.cuentaId);
  }
}
