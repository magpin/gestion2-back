import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { TesoreriaModule } from '../tesoreria/tesoreria.module';
import { CotizacionesController } from './controladores/cotizaciones.controller';
import { FacturasController } from './controladores/facturas.controller';
import { FaltantesController } from './controladores/faltantes.controller';
import { NotasCreditoController } from './controladores/notas-credito.controller';
import { FacturaService } from './servicios/factura.service';
import { FaltanteService } from './servicios/faltante.service';
import { NotaCreditoService } from './servicios/nota-credito.service';
import { VentaDocumentoService } from './servicios/venta-documento.service';
import { VentasApi } from './ventas.api';

/**
 * Ventas — módulo #4 de la secuencia. Cotización, factura de venta y nota
 * crédito, todas sobre `venta_documento` con un solo `tipo`.
 *
 * Importa `NucleoModule`, `ContabilidadModule` e `InventarioModule`: es el
 * módulo con más dependencias del sistema, tal como ya lo anticipaba
 * `secuencia-modulos.md` — necesita un tercero a quién facturar, un
 * producto que vender, una resolución que numere y un libro donde asentar.
 * `TesoreriaModule` se sumó en el paso 12 de `caja-bancos-backend.md`:
 * `VentaDocumentoService.cobrar` necesita `TesoreriaApi`.
 *
 * Solo exporta `VentasApi` — hoy vacía, ver el porqué en `ventas.api.ts`.
 */
@Module({
  imports: [
    NucleoModule,
    ContabilidadModule,
    InventarioModule,
    TesoreriaModule,
  ],
  controllers: [
    CotizacionesController,
    FacturasController,
    FaltantesController,
    NotasCreditoController,
  ],
  providers: [
    VentaDocumentoService,
    FacturaService,
    FaltanteService,
    NotaCreditoService,
    VentasApi,
  ],
  exports: [VentasApi],
})
export class VentasModule {}
