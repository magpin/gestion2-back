import { Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { ConfiguracionController } from './controladores/configuracion.controller';
import { MovimientosController } from './controladores/movimientos.controller';
import { CategoriasController } from './controladores/categorias.controller';
import { ProductosController } from './controladores/productos.controller';
import { InventarioApi } from './inventario.api';
import { ConfiguracionService } from './servicios/configuracion.service';
import { KardexService } from './servicios/kardex.service';
import { PrecioService } from './servicios/precio.service';
import { CategoriaService } from './servicios/categoria.service';
import { ProductoService } from './servicios/producto.service';

/**
 * Productos e inventario — módulo #3 de `docs/decisiones/secuencia-modulos.md`.
 *
 * Importa `NucleoModule` y `ContabilidadModule` porque `KardexService`
 * necesita `NucleoApi` (la configuración contable, para saber si la empresa
 * usa promedio ponderado) y `ContabilidadApi` (para asentar los ajustes) — a
 * diferencia de `contabilidad`, que no depende de ningún módulo anterior.
 *
 * Solo exporta `InventarioApi`, y hoy es una fachada parcial a propósito: ver
 * el comentario de esa clase y `docs/planes/productos-inventario-restante.md`.
 */
@Module({
  imports: [NucleoModule, ContabilidadModule],
  controllers: [
    CategoriasController,
    ProductosController,
    MovimientosController,
    ConfiguracionController,
  ],
  providers: [
    CategoriaService,
    ProductoService,
    PrecioService,
    KardexService,
    ConfiguracionService,
    InventarioApi,
  ],
  exports: [InventarioApi],
})
export class InventarioModule {}
