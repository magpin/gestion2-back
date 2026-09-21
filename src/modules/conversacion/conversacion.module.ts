import { Module } from '@nestjs/common';

import { ConversacionController } from './controladores/conversacion.controller';
import { ClaudeConversador } from './proveedores/claude.conversador';
import { CONVERSADOR } from './proveedores/conversador.puerto';
import { ConversacionService } from './servicios/conversacion.service';

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
 * En este paso no ve datos de la empresa ni escribe nada del negocio: solo
 * conversa. Eso llega en los pasos 6 y 7.
 */
@Module({
  controllers: [ConversacionController],
  providers: [
    ConversacionService,
    { provide: CONVERSADOR, useClass: ClaudeConversador },
  ],
})
export class ConversacionModule {}
