import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConsumoIaModule } from '../consumo-ia/consumo-ia.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { AnunciosController } from './controladores/anuncios.controller';
import { PlataformaController } from './controladores/plataforma.controller';
import { PlataformaGuard } from './plataforma.guard';
import { CobrosService } from './servicios/cobros.service';
import { CuentasService } from './servicios/cuentas.service';
import { PanelService } from './servicios/panel.service';
import { LeyRetencionesService } from './servicios/ley-retenciones.service';
import { SistemaService } from './servicios/sistema.service';

/**
 * `plataforma` — la administración del producto, no de las contabilidades.
 *
 * Es el único módulo que usa la conexión con BYPASSRLS para leer, y por eso su
 * alcance está cerrado por diseño: cuentas, empresas, usuarios y permisos. Nunca
 * una tabla contable.
 *
 * Lee el avance de la configuración por `NucleoApi` y el consumo de la IA por
 * `ConsumoIaApi`: las dos superficies públicas, no sus servicios.
 *
 * No exporta nada. Ningún módulo de negocio debería poder llamarlo.
 */
@Module({
  imports: [JwtModule.register({}), NucleoModule, ConsumoIaModule],
  controllers: [PlataformaController, AnunciosController],
  providers: [
    CuentasService,
    PanelService,
    CobrosService,
    SistemaService,
    LeyRetencionesService,
    PlataformaGuard,
  ],
})
export class PlataformaModule {}
