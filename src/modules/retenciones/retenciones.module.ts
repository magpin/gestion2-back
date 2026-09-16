import { Global, Module } from '@nestjs/common';

import { RetencionesController } from './controladores/retenciones.controller';
import { RetencionesApi } from './retenciones.api';
import { RetencionService } from './servicios/retencion.service';

/**
 * Global porque tanto Compras como Ventas necesitan la misma fachada, y el
 * cálculo es idéntico de los dos lados: lo que cambia es contra qué cuenta va
 * lo retenido.
 */
@Global()
@Module({
  controllers: [RetencionesController],
  providers: [RetencionService, RetencionesApi],
  exports: [RetencionesApi],
})
export class RetencionesModule {}
