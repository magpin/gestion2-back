import { Module } from '@nestjs/common';

import { AsientosController } from './controladores/asientos.controller';
import { ComprobantesController } from './controladores/comprobantes.controller';
import { LibrosController } from './controladores/libros.controller';
import { PeriodosController } from './controladores/periodos.controller';
import { ContabilidadApi } from './contabilidad.api';
import { AsientoService } from './servicios/asiento.service';
import { ComprobanteManualService } from './servicios/comprobante-manual.service';
import { ComprobanteService } from './servicios/comprobante.service';
import { LibrosService } from './servicios/libros.service';
import { PeriodoService } from './servicios/periodo.service';

/**
 * El libro.
 *
 * Modulo propio y no un controlador mas de `nucleo` porque es otro contexto: no
 * comparte transaccion con la ficha de la empresa, y todo lo que viene despues
 * —ventas, compras, nomina— produce asientos contra el.
 *
 * Solo exporta `ContabilidadApi`. Los servicios son internos.
 */
@Module({
  controllers: [
    PeriodosController,
    ComprobantesController,
    AsientosController,
    LibrosController,
  ],
  providers: [
    PeriodoService,
    ComprobanteService,
    AsientoService,
    ComprobanteManualService,
    LibrosService,
    ContabilidadApi,
  ],
  exports: [ContabilidadApi],
})
export class ContabilidadModule {}
