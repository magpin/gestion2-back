import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PlataformaController } from './controladores/plataforma.controller';
import { PlataformaGuard } from './plataforma.guard';
import { CuentasService } from './servicios/cuentas.service';

/**
 * `plataforma` — la administración del producto, no de las contabilidades.
 *
 * Es el único módulo que usa la conexión con BYPASSRLS para leer, y por eso su
 * alcance está cerrado por diseño: cuentas, empresas, usuarios y permisos. Nunca
 * una tabla contable.
 *
 * No exporta nada. Ningún módulo de negocio debería poder llamarlo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlataformaController],
  providers: [CuentasService, PlataformaGuard],
})
export class PlataformaModule {}
