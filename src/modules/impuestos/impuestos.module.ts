import { Module } from '@nestjs/common';

import { AlmacenamientoModule } from '../almacenamiento/almacenamiento.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { ReportesModule } from '../reportes/reportes.module';
import { TesoreriaModule } from '../tesoreria/tesoreria.module';
import { ImpuestosController } from './impuestos.controller';
import { ImpuestosService } from './impuestos.service';

/**
 * `impuestos` — Contabilidad → Impuestos (Fase 1 de las pantallas
 * complementarias): el calendario tributario, el 350 del mes, y la
 * presentación y el pago de cada declaración.
 *
 * El 350 lo arma `reportes` (el mismo de la hoja impresa); los saldos, el
 * libro; el pago sale por tesorería contra varias cuentas. Nada se
 * transmite a la DIAN.
 */
@Module({
  imports: [
    NucleoModule,
    TesoreriaModule,
    AlmacenamientoModule,
    ReportesModule,
  ],
  controllers: [ImpuestosController],
  providers: [ImpuestosService],
  exports: [ImpuestosService],
})
export class ImpuestosModule {}
