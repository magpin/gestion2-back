import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { CajaArqueosController } from './controladores/caja-arqueos.controller';
import { CajaConfiguracionController } from './controladores/caja-configuracion.controller';
import { CajaMovimientosController } from './controladores/caja-movimientos.controller';
import { CajasController } from './controladores/cajas.controller';
import { CuentasBancariasController } from './controladores/cuentas-bancarias.controller';
import { CajaArqueoService } from './servicios/caja-arqueo.service';
import { CajaConfiguracionService } from './servicios/caja-configuracion.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';
import { CajaService } from './servicios/caja.service';
import { CuentaBancariaService } from './servicios/cuenta-bancaria.service';
import { TesoreriaApi } from './tesoreria.api';

/**
 * Tesorería (módulo 7 de la secuencia): Caja y Bancos. Bancos se suma
 * pieza por pieza en la Fase 2 del plan
 * (`docs/planes/caja-bancos-fase2.md`) — a diferencia de Caja, que llegó
 * de una sola vez en el paso 10, acá cada servicio/controlador nuevo se
 * registra en este módulo al construirse, no al final.
 *
 * Importa `ContabilidadModule` porque `CajaMovimientoService`/
 * `CajaArqueoService` (y, más adelante, `BancoMovimientoService`)
 * necesitan `ContabilidadApi` para asentar — mismo motivo que
 * `InventarioModule`.
 *
 * Solo exporta `TesoreriaApi`, mismo patrón que `ContabilidadApi`/
 * `InventarioApi`: todo lo demás es interno, y ningún otro módulo lo
 * importa directamente.
 */
@Module({
  imports: [ContabilidadModule],
  controllers: [
    CajasController,
    CajaMovimientosController,
    CajaArqueosController,
    CajaConfiguracionController,
    CuentasBancariasController,
  ],
  providers: [
    CajaService,
    CajaMovimientoService,
    CajaArqueoService,
    CajaConfiguracionService,
    CuentaBancariaService,
    TesoreriaApi,
  ],
  exports: [TesoreriaApi],
})
export class TesoreriaModule {}
