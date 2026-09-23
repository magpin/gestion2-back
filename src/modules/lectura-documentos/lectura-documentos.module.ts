import { Module } from '@nestjs/common';

import { AlmacenamientoModule } from '../almacenamiento/almacenamiento.module';
import { ComprasModule } from '../compras/compras.module';
import { VentasModule } from '../ventas/ventas.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { ConfirmacionController } from './controladores/confirmacion.controller';
import { DocumentosController } from './controladores/documentos.controller';
import { ExtraccionController } from './controladores/extraccion.controller';
import { FacturasLeidasController } from './controladores/facturas-leidas.controller';
import { AltasController } from './controladores/altas.controller';
import { LotesController } from './controladores/lotes.controller';
import { PedidosLeidosController } from './controladores/pedidos-leidos.controller';
import { LecturaDocumentosApi } from './lectura-documentos.api';
import { ClaudeProveedor } from './proveedores/claude.proveedor';
import { EXTRACTOR_PUERTO } from './proveedores/extractor.puerto';
import { ConfirmacionFacturaService } from './servicios/confirmacion-factura.service';
import { ConfirmacionService } from './servicios/confirmacion.service';
import { CruceService } from './servicios/cruce.service';
import { DocumentoService } from './servicios/documento.service';
import { ExtractorService } from './servicios/extractor.service';
import { FacturacionPedidoService } from './servicios/facturacion-pedido.service';
import { LoteService } from './servicios/lote.service';
import { MemoriaService } from './servicios/memoria.service';
import { ProgresoService } from './servicios/progreso.service';

/**
 * `lectura-documentos` — lee un documento y propone hechos.
 *
 * No configura empresas: eso lo siguen haciendo los servicios de `nucleo`, y solo
 * cuando una persona confirma. Es módulo aparte porque falla por sus propias
 * razones —la API del modelo, el límite, la clave, un PDF ilegible—, porque
 * guarda la clave de un tercero y maneja el RUT de una empresa real, y porque se
 * construye sin tocar nada de lo demás.
 *
 * El proveedor se registra bajo `EXTRACTOR_PUERTO` y no por su clase: quien
 * depende de él depende de la interfaz, que es lo que hace que el día que la
 * extracción la haga un OCR se cambie una línea acá y nada más.
 */
@Module({
  imports: [
    AlmacenamientoModule,
    NucleoModule,
    InventarioModule,
    ComprasModule,
    VentasModule,
  ],
  controllers: [
    DocumentosController,
    ExtraccionController,
    ConfirmacionController,
    FacturasLeidasController,
    PedidosLeidosController,
    LotesController,
    AltasController,
  ],
  providers: [
    DocumentoService,
    ProgresoService,
    ExtractorService,
    ConfirmacionService,
    ConfirmacionFacturaService,
    CruceService,
    FacturacionPedidoService,
    MemoriaService,
    LoteService,
    { provide: EXTRACTOR_PUERTO, useClass: ClaudeProveedor },
    LecturaDocumentosApi,
  ],
  exports: [LecturaDocumentosApi],
})
export class LecturaDocumentosModule {}
