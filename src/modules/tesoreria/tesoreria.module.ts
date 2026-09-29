import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { BancoCortesController } from './controladores/banco-cortes.controller';
import { BancoMovimientosController } from './controladores/banco-movimientos.controller';
import { CajaArqueosController } from './controladores/caja-arqueos.controller';
import { CajaConfiguracionController } from './controladores/caja-configuracion.controller';
import { CajaMovimientosController } from './controladores/caja-movimientos.controller';
import { CajasController } from './controladores/cajas.controller';
import { CuentasBancariasController } from './controladores/cuentas-bancarias.controller';
import { ExtractoReglasController } from './controladores/extracto-reglas.controller';
import { ExtractoController } from './controladores/extracto.controller';
import { ExtractosController } from './controladores/extractos.controller';
import { BancoCorteService } from './servicios/banco-corte.service';
import { BancoMovimientoService } from './servicios/banco-movimiento.service';
import { CajaArqueoService } from './servicios/caja-arqueo.service';
import { CajaConfiguracionService } from './servicios/caja-configuracion.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';
import { CajaService } from './servicios/caja.service';
import { CuentaBancariaService } from './servicios/cuenta-bancaria.service';
import { ExtractoReglaService } from './servicios/extracto-regla.service';
import { ExtractoService } from './servicios/extracto.service';
import { TesoreriaApi } from './tesoreria.api';
import { MovimientosConceptoController } from './controladores/movimientos-concepto.controller';
import { MovimientoConceptoService } from './servicios/movimiento-concepto.service';
import { TrasladosController } from './controladores/traslados.controller';
import { CajaBancosController } from './controladores/caja-bancos.controller';
import { CajaBancosService } from './servicios/caja-bancos.service';
import { TrasladoService } from './servicios/traslado.service';

/**
 * Tesorería (módulo 7 de la secuencia): Caja y Bancos. Bancos se suma
 * pieza por pieza en la Fase 2 del plan
 * (`docs/planes/caja-bancos-fase2.md`) — a diferencia de Caja, que llegó
 * de una sola vez en el paso 10, acá cada servicio/controlador nuevo se
 * registra en este módulo al construirse, no al final.
 *
 * Importa `NucleoModule` porque `CajaConfiguracionService` necesita el plan
 * de cuentas, las sedes y los hechos operativos para dejar tesorería lista.
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
  imports: [NucleoModule, ContabilidadModule],
  controllers: [
    CajasController,
    CajaMovimientosController,
    CajaArqueosController,
    CajaConfiguracionController,
    CuentasBancariasController,
    BancoMovimientosController,
    BancoCortesController,
    ExtractosController,
    ExtractoController,
    ExtractoReglasController,
    MovimientosConceptoController,
    TrasladosController,
    CajaBancosController,
  ],
  providers: [
    CajaService,
    CajaMovimientoService,
    CajaArqueoService,
    CajaConfiguracionService,
    CuentaBancariaService,
    BancoMovimientoService,
    BancoCorteService,
    ExtractoService,
    ExtractoReglaService,
    MovimientoConceptoService,
    TrasladoService,
    CajaBancosService,
    TesoreriaApi,
  ],
  exports: [TesoreriaApi],
})
export class TesoreriaModule {}
