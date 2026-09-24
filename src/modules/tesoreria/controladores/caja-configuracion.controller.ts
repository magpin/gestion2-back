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
import { FijarCuentaConceptoDto } from '../dto/caja-configuracion.dto';
import { CajaConfiguracionService } from '../servicios/caja-configuracion.service';
import type { ConceptoArqueo } from '../servicios/caja.reglas';

const CONCEPTOS = {
  SOBRANTE: 'SOBRANTE',
  FALTANTE_COBRABLE: 'FALTANTE_COBRABLE',
  FALTANTE_ASUMIDO: 'FALTANTE_ASUMIDO',
} as const satisfies Record<ConceptoArqueo, ConceptoArqueo>;

/**
 * `tesoreria/configuracion`, no `cajas/configuracion`: `CajasController` ya
 * tiene `GET /cajas/:id` con `ParseUUIDPipe` — anidar acá bajo `cajas`
 * haría que `/cajas/configuracion` compitiera con esa ruta. Mismo nivel que
 * el módulo, igual que `inventario/configuracion` cuelga de `inventario`
 * y no de `productos`.
 */
@Controller('tesoreria/configuracion')
@ExigeEmpresa()
export class CajaConfiguracionController {
  constructor(private readonly configuracion: CajaConfiguracionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CAJA')
  @Get()
  obtener(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.obtener(ctx);
  }

  /**
   * Crea lo que falte para operar: cuentas de arqueo, cajas por sede y caja
   * menor. Idempotente. Solo CONTADOR/DIRECTOR: crea cuentas en el plan.
   */
  @Roles('CONTADOR', 'DIRECTOR')
  @Post('preparar')
  preparar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.configuracion.preparar(ctx);
  }

  /** Solo CONTADOR/DIRECTOR: elegir la cuenta es juicio contable, no operación de caja. */
  @Roles('CONTADOR', 'DIRECTOR')
  @Put(':concepto')
  fijar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('concepto', new ParseEnumPipe(CONCEPTOS)) concepto: ConceptoArqueo,
    @Body() dto: FijarCuentaConceptoDto,
  ) {
    return this.configuracion.fijar(ctx, concepto, dto.cuentaId);
  }
}
