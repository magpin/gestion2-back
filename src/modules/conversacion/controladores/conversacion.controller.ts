import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import { ROLES, type CtxEmpresa } from '../../../common/ctx';
import { TurnoDto } from '../dto/conversacion.dto';
import { ConversacionService } from '../servicios/conversacion.service';

/**
 * Conversar con el asistente (paso 4 de `asistente-conversacion.md`).
 *
 * **Todos los roles de la empresa**, listados uno por uno: `DIRECTOR` no es
 * superusuario en este sistema. Conversar no escribe nada del negocio, y cada
 * persona ve solo sus conversaciones.
 *
 * Ninguna ruta recibe el id de una conversación: todo es «la vigente de quien
 * pregunta». Así no hay id ajeno que probar.
 */
@Controller('conversacion')
@ExigeEmpresa()
@Roles(...ROLES)
export class ConversacionController {
  constructor(private readonly conversacion: ConversacionService) {}

  /** Si se puede conversar. Solo depende de la clave del modelo, no del bucket. */
  @Get('disponible')
  disponible(): { disponible: boolean } {
    return { disponible: this.conversacion.disponible };
  }

  @Get()
  vigente(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.conversacion.vigente(ctx);
  }

  /** «Empezar de nuevo»: archiva la vigente. */
  @Post('nueva')
  @HttpCode(204)
  async nueva(@ActorEmpresa() ctx: CtxEmpresa): Promise<void> {
    await this.conversacion.archivar(ctx);
  }

  /**
   * Una pregunta y su respuesta, en vivo.
   *
   * Lo que puede fallar antes de llamar al modelo —el límite por minuto, el
   * tope del hilo, otra respuesta en curso, la clave— falla con un error
   * normal, antes de abrir el flujo. Después, la respuesta va como eventos:
   *
   *   `PREGUNTA` — la pregunta ya guardada, con su id y su orden;
   *   `TROZO`    — un pedazo de texto, a medida que el modelo lo escribe;
   *   `FIN`      — la respuesta guardada, con su estado (COMPLETO, CORTADO,
   *                RECHAZADO o FALLO) y su motivo.
   *
   * Es un POST, así que no sirve `@Sse` (solo GET): los eventos se escriben a
   * mano con el mismo formato. El token va en `Authorization`, como en todo.
   * Si la persona cierra la pestaña, se corta la llamada al modelo y el turno
   * queda CORTADO con lo que alcanzó.
   */
  @Post('turnos')
  async turno(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: TurnoDto,
    @Res() res: Response,
  ): Promise<void> {
    const preparado = await this.conversacion.preparar(ctx, dto.texto);

    const corte = new AbortController();
    // `close` de la respuesta, no del pedido: el del pedido salta apenas se
    // termina de leer el cuerpo, y cortaría cada llamada al nacer.
    res.on('close', () => {
      if (!res.writableEnded) corte.abort();
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Que ningún proxy junte los eventos: un flujo en vivo que llega de golpe
    // es el mismo problema que una respuesta que aparece a los ocho segundos.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const enviar = (evento: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(evento)}\n\n`);
    };

    enviar({ tipo: 'PREGUNTA', turno: preparado.pregunta });
    try {
      const respuesta = await this.conversacion.responder(ctx, preparado, {
        alEscribir: (texto) => enviar({ tipo: 'TROZO', texto }),
        corte: corte.signal,
      });
      enviar({ tipo: 'FIN', turno: respuesta });
    } catch {
      // La respuesta del modelo ya se tradujo a un estado; lo que llega acá es
      // una falla al guardar. El flujo ya está abierto: no hay código HTTP que
      // mandar, así que se dice con un evento.
      enviar({
        tipo: 'ERROR',
        motivo: 'No pude guardar la respuesta. Recargá la conversación.',
      });
    } finally {
      res.end();
    }
  }
}
