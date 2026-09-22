import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';

import { Publico } from '../../common/auth/decoradores';
import { ClaveConsumoGuard } from './clave-consumo.guard';
import { ConsumoIaApi } from './consumo-ia.api';
import { ConsumoIaService } from './servicios/consumo-ia.service';

/**
 * El tablero de consumo de la IA, aparte del sistema
 * (`docs/planes/consumo-ia.md`).
 *
 * `@Publico` apaga las guardias de sesión de empresa —el tablero no pertenece a
 * ninguna— y `ClaveConsumoGuard` pone la suya: la clave de `CLAVE_CONSUMO_IA`
 * en la cabecera `x-clave-consumo`. Nunca en la URL: una URL queda en el
 * historial, en los registros del servidor y en las capturas de pantalla.
 */
@Controller('consumo-ia')
@Publico()
@UseGuards(ClaveConsumoGuard)
export class ConsumoIaController {
  constructor(private readonly consumo: ConsumoIaService) {}

  /** Todo el tablero del período: `?desde=aaaa-mm-dd&hasta=aaaa-mm-dd&empresa=<id>`. */
  @Get()
  tablero(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('empresa') empresaId?: string,
  ) {
    return this.consumo.tablero({ desde, hasta, empresaId });
  }

  /**
   * Cada llamada al modelo y en qué se gastó. Los mismos filtros, más
   * `?categoria=`, `?orden=FECHA|COSTO` y `?pagina=`.
   */
  @Get('detalle')
  detalle(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('empresa') empresaId?: string,
    @Query('categoria') categoria?: string,
    @Query('orden') orden?: string,
    @Query('pagina') pagina?: string,
  ) {
    return this.consumo.detalle({
      desde,
      hasta,
      empresaId,
      categoria,
      orden,
      pagina,
    });
  }
}

/**
 * Módulo propio y no dentro de `plataforma`: ese módulo se limita a propósito
 * a cuentas, empresas y usuarios. Este solo lee cifras de uso de la IA, por la
 * conexión de aprovisionamiento.
 *
 * Exporta `ConsumoIaApi`, que usa la consola de plataforma.
 */
@Module({
  controllers: [ConsumoIaController],
  providers: [ConsumoIaService, ClaveConsumoGuard, ConsumoIaApi],
  exports: [ConsumoIaApi],
})
export class ConsumoIaModule {}
