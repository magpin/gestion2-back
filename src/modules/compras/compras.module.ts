import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { TesoreriaModule } from '../tesoreria/tesoreria.module';
import { ComprasController } from './controladores/compras.controller';
import { NotasCompraController } from './controladores/notas-compra.controller';
import { CompraNotaService } from './servicios/compra-nota.service';
import { CompraService } from './servicios/compra.service';
import { ComprasApi } from './compras.api';

/**
 * Compras — módulo #5 de la secuencia. Factura de compra, su entrada al
 * inventario, el asiento que produce, y las dos notas del proveedor —crédito
 * y débito— que viven en la misma tabla desde `0039`.
 *
 * Importa `NucleoModule`, `ContabilidadModule` e `InventarioModule`, igual
 * que `VentasModule`: necesita un proveedor a quién comprarle, un producto
 * cuyo kardex aumentar y un libro donde asentar. `TesoreriaModule` se sumó
 * en el paso 12 de `caja-bancos-backend.md`: `CompraService.pagar`
 * necesita `TesoreriaApi`.
 *
 * Solo exporta `ComprasApi` — hoy vacía, ver el porqué en `compras.api.ts`.
 */
@Module({
  imports: [
    NucleoModule,
    ContabilidadModule,
    InventarioModule,
    TesoreriaModule,
  ],
  controllers: [ComprasController, NotasCompraController],
  providers: [CompraService, CompraNotaService, ComprasApi],
  exports: [ComprasApi],
})
export class ComprasModule {}
