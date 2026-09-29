import { Module } from '@nestjs/common';

import { ComprasModule } from '../compras/compras.module';
import { TesoreriaModule } from '../tesoreria/tesoreria.module';
import { VentasModule } from '../ventas/ventas.module';
import { EstadosFinancierosController } from './estados-financieros.controller';
import { EstadosFinancierosService } from './estados-financieros.service';
import { TableroController } from './tablero.controller';
import { TableroService } from './tablero.service';

/**
 * `estados-financieros` — Análisis → Estados financieros (Fase 7 del menú
 * nuevo): estado de resultados, balance general y flujo de caja, real y
 * proyectado. También el tablero de la plata de Inicio (Fase 8), que junta
 * saldos, cartera, lo por pagar y el resultado del mes.
 *
 * **Solo lee.** El libro lo lee directo, como `reportes`; lo pendiente de
 * cobrar y de pagar, por las fachadas de ventas y compras; los saldos, por
 * la de tesorería. `reportes` usa el servicio para el PDF y el Excel.
 */
@Module({
  imports: [VentasModule, ComprasModule, TesoreriaModule],
  controllers: [EstadosFinancierosController, TableroController],
  providers: [EstadosFinancierosService, TableroService],
  exports: [EstadosFinancierosService],
})
export class EstadosFinancierosModule {}
