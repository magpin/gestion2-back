import { Module } from '@nestjs/common';

import { ComprasModule } from '../compras/compras.module';
import { ContabilidadModule } from '../contabilidad/contabilidad.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { ReportesModule } from '../reportes/reportes.module';
import { TesoreriaModule } from '../tesoreria/tesoreria.module';
import { VentasModule } from '../ventas/ventas.module';

import { ConversacionController } from './controladores/conversacion.controller';
import { ClaudeConversador } from './proveedores/claude.conversador';
import { CONVERSADOR } from './proveedores/conversador.puerto';
import { ConsultasService } from './servicios/consultas.service';
import { ConversacionService } from './servicios/conversacion.service';
import { PropuestasService } from './servicios/propuestas.service';

/**
 * `conversacion` — conversar con el asistente.
 *
 * Módulo aparte de `lectura-documentos` porque falla por otras razones: la
 * conversación se quedó sin contexto, el modelo se fue por las ramas, la
 * pregunta era sobre datos que la persona no puede ver. No lee archivos ni
 * necesita el bucket (§3 de `docs/decisiones/arquitectura-modulos.md`).
 *
 * El adaptador se registra bajo `CONVERSADOR` y no por su clase: el servicio
 * depende de la interfaz.
 *
 * Desde el paso 6 **ve** datos de la empresa: consulta el armador de
 * reportes, los saldos de tesorería y las existencias de inventario, con los
 * permisos de quien pregunta (`ConsultasService`). Todavía no escribe nada del
 * negocio por su cuenta.
 *
 * Desde el paso 7 **propone** cobros y pagos (`PropuestasService`): los
 * verifica en seco con el código de ventas y compras, y una persona los
 * confirma (`docs/planes/asistente-acciones.md`).
 */
@Module({
  imports: [
    ReportesModule,
    TesoreriaModule,
    InventarioModule,
    VentasModule,
    ComprasModule,
    NucleoModule,
    // Para dejar anotado en el asiento de qué propuesta salió.
    ContabilidadModule,
  ],
  controllers: [ConversacionController],
  providers: [
    ConversacionService,
    ConsultasService,
    PropuestasService,
    { provide: CONVERSADOR, useClass: ClaudeConversador },
  ],
})
export class ConversacionModule {}
