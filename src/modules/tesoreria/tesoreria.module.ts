import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { CajaArqueosController } from './controladores/caja-arqueos.controller';
import { CajaConfiguracionController } from './controladores/caja-configuracion.controller';
import { CajaMovimientosController } from './controladores/caja-movimientos.controller';
import { CajasController } from './controladores/cajas.controller';
import { CajaArqueoService } from './servicios/caja-arqueo.service';
import { CajaConfiguracionService } from './servicios/caja-configuracion.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';
import { CajaService } from './servicios/caja.service';
import { TesoreriaApi } from './tesoreria.api';

/**
 * Tesorería (módulo 7 de la secuencia): Caja y Bancos. Por ahora solo Caja
 * — Bancos llega en la Fase 2 del plan (`docs/planes/caja-bancos-backend.md`).
 *
 * Importa `ContabilidadModule` porque `CajaMovimientoService` y
 * `CajaArqueoService` necesitan `ContabilidadApi` para asentar ingresos,
 * egresos y el ajuste de arqueo — mismo motivo que `InventarioModule`.
 *
 * Solo exporta `TesoreriaApi`, mismo patrón que `ContabilidadApi`/
 * `InventarioApi`: `CajaService`/`CajaMovimientoService`/`CajaArqueoService`/
 * `CajaConfiguracionService` son internos, y ningún otro módulo los importa
 * directamente.
 */
@Module({
  imports: [ContabilidadModule],
  controllers: [
    CajasController,
    CajaMovimientosController,
    CajaArqueosController,
    CajaConfiguracionController,
  ],
  providers: [
    CajaService,
    CajaMovimientoService,
    CajaArqueoService,
    CajaConfiguracionService,
    TesoreriaApi,
  ],
  exports: [TesoreriaApi],
})
export class TesoreriaModule {}
