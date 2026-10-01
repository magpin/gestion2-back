import { Global, Module } from '@nestjs/common';

import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { RetencionesController } from './controladores/retenciones.controller';
import { ClaudeClasificador } from './proveedores/claude.clasificador';
import { CLASIFICADOR_PUERTO } from './proveedores/clasificador.puerto';
import { RetencionesApi } from './retenciones.api';
import { ClasificadorIaService } from './servicios/clasificador-ia.service';
import { MotorRentaService } from './servicios/motor-renta.service';
import { MotorVentaService } from './servicios/motor-venta.service';
import { ParametrosService } from './servicios/parametros.service';
import { PerfilTerceroService } from './servicios/perfil-tercero.service';
import { RecalculoService } from './servicios/recalculo.service';
import { RetencionService } from './servicios/retencion.service';
import { AnticipoRetencionService } from './servicios/anticipo-retencion.service';

/**
 * Global porque tanto Compras como Ventas necesitan la misma fachada, y el
 * cálculo es idéntico de los dos lados: lo que cambia es contra qué cuenta va
 * lo retenido.
 */
@Global()
@Module({
  imports: [ContabilidadModule, NucleoModule],
  controllers: [RetencionesController],
  providers: [
    RetencionService,
    ParametrosService,
    MotorRentaService,
    MotorVentaService,
    PerfilTerceroService,
    RecalculoService,
    ClasificadorIaService,
    { provide: CLASIFICADOR_PUERTO, useClass: ClaudeClasificador },
    AnticipoRetencionService,
    RetencionesApi,
  ],
  exports: [RetencionesApi],
})
export class RetencionesModule {}
