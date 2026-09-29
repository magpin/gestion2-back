import { Module } from '@nestjs/common';

import { NucleoModule } from '../nucleo/nucleo.module';
import { GastosController } from './gastos.controller';
import { GastosService } from './gastos.service';

/**
 * `gastos` — Egresos → Gastos (Fase 6 del menú nuevo).
 *
 * **Solo lee.** Un gasto se registra por Compras (con factura o documento
 * soporte) o por Pagos (sin factura); acá se suma por concepto. Lee directo
 * las líneas de asiento y los documentos que las originaron, como `reportes`.
 */
@Module({
  imports: [NucleoModule],
  controllers: [GastosController],
  providers: [GastosService],
})
export class GastosModule {}
