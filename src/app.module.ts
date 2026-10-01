import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthModule } from './common/auth/auth.module';
import { JwtGuard } from './common/auth/jwt.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { DbModule } from './common/db/db.module';
import { PausaIaModule } from './common/ia/pausa-ia.service';
import { AlmacenamientoModule } from './modules/almacenamiento/almacenamiento.module';
import { RetencionesModule } from './modules/retenciones/retenciones.module';
import { ErrorPostgresFilter } from './common/db/error-postgres.filter';
import { SaludController } from './health/salud.controller';
import { ComprasModule } from './modules/compras/compras.module';
import { ContabilidadModule } from './modules/contabilidad/contabilidad.module';
import { InventarioModule } from './modules/inventario/inventario.module';
import { LecturaDocumentosModule } from './modules/lectura-documentos/lectura-documentos.module';
import { ConsumoIaModule } from './modules/consumo-ia/consumo-ia.module';
import { ConversacionModule } from './modules/conversacion/conversacion.module';
import { NucleoModule } from './modules/nucleo/nucleo.module';
import { PlataformaModule } from './modules/plataforma/plataforma.module';
import { ReportesModule } from './modules/reportes/reportes.module';
import { GastosModule } from './modules/gastos/gastos.module';
import { EstadosFinancierosModule } from './modules/estados-financieros/estados-financieros.module';
import { ImpuestosModule } from './modules/impuestos/impuestos.module';
import { RevisionModule } from './modules/revision/revision.module';
import { TesoreriaModule } from './modules/tesoreria/tesoreria.module';
import { TrazabilidadModule } from './modules/trazabilidad/trazabilidad.module';
import { VentasModule } from './modules/ventas/ventas.module';

/**
 * Raíz de la aplicación.
 *
 * Cuelgan `nucleo` —la empresa y todo lo que la define antes de mover un peso—,
 * `contabilidad`, el libro, `inventario`, que se apoya en los dos, `ventas` y
 * `compras`, que se apoyan en los tres, y `tesoreria` (Caja y Bancos —hoy solo
 * Caja—), que se apoya en `contabilidad` para asentar sus movimientos, igual
 * que `inventario` — los módulos hermanos, con más dependencias del sistema.
 * Los que siguen —dian, nómina— se construyen encima, cada uno apoyado solo
 * en los anteriores.
 *
 * El orden de los guards importa: `JwtGuard` arma el `Ctx` que `RolesGuard`
 * después lee. Van acá y no en `AuthModule` para que apliquen a todo endpoint
 * por defecto: un endpoint nuevo nace protegido, y abrirlo exige escribir
 * `@Publico()` a mano.
 */
@Module({
  imports: [
    DbModule,
    PausaIaModule,
    AlmacenamientoModule,
    RetencionesModule,
    AuthModule,
    NucleoModule,
    ContabilidadModule,
    InventarioModule,
    VentasModule,
    ComprasModule,
    PlataformaModule,
    TesoreriaModule,
    LecturaDocumentosModule,
    ConversacionModule,
    ConsumoIaModule,
    ReportesModule,
    GastosModule,
    EstadosFinancierosModule,
    ImpuestosModule,
    RevisionModule,
    TrazabilidadModule,
  ],
  controllers: [SaludController],
  providers: [
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: ErrorPostgresFilter },
  ],
})
export class AppModule {}
