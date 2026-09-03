import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthModule } from './common/auth/auth.module';
import { JwtGuard } from './common/auth/jwt.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { DbModule } from './common/db/db.module';
import { ErrorPostgresFilter } from './common/db/error-postgres.filter';
import { SaludController } from './health/salud.controller';
import { NucleoModule } from './modules/nucleo/nucleo.module';
import { PlataformaModule } from './modules/plataforma/plataforma.module';

/**
 * Raíz de la aplicación.
 *
 * Hoy solo cuelga `nucleo`. Los módulos de negocio —contabilidad, impuestos,
 * inventario, compras, ventas, facturación, dian, tesorería, cierre, reportes—
 * se construyen encima, cada uno apoyado solo en los anteriores.
 *
 * El orden de los guards importa: `JwtGuard` arma el `Ctx` que `RolesGuard`
 * después lee. Van acá y no en `AuthModule` para que apliquen a todo endpoint
 * por defecto: un endpoint nuevo nace protegido, y abrirlo exige escribir
 * `@Publico()` a mano.
 */
@Module({
  imports: [DbModule, AuthModule, NucleoModule, PlataformaModule],
  controllers: [SaludController],
  providers: [
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: ErrorPostgresFilter },
  ],
})
export class AppModule {}
