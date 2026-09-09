import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { ComprasController } from './controladores/compras.controller';
import { CompraService } from './servicios/compra.service';
import { ComprasApi } from './compras.api';

/**
 * Compras — módulo #5 de la secuencia. Factura de compra, su entrada al
 * inventario y el asiento que produce.
 *
 * Importa `NucleoModule`, `ContabilidadModule` e `InventarioModule`, igual
 * que `VentasModule`: necesita un proveedor a quién comprarle, un producto
 * cuyo kardex aumentar y un libro donde asentar.
 *
 * Solo exporta `ComprasApi` — hoy vacía, ver el porqué en `compras.api.ts`.
 */
@Module({
  imports: [NucleoModule, ContabilidadModule, InventarioModule],
  controllers: [ComprasController],
  providers: [CompraService, ComprasApi],
  exports: [ComprasApi],
})
export class ComprasModule {}
