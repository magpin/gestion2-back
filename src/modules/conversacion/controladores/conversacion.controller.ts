import {
  Body,
  Controller,
  Get,
  HttpCode,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { PausaIaService } from '../../../common/ia/pausa-ia.service';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import { ROLES, type CtxEmpresa } from '../../../common/ctx';
import { ConfirmarPropuestaDto, TurnoDto } from '../dto/conversacion.dto';
import { ConversacionService } from '../servicios/conversacion.service';
import { PendientesService } from '../servicios/pendientes.service';
import { PropuestasService } from '../servicios/propuestas.service';

/**
 * Conversar con el asistente (paso 4 de `asistente-conversacion.md`).
 *
 * **Todos los roles de la empresa**, listados uno por uno: `DIRECTOR` no es
 * superusuario en este sistema. Conversar no escribe nada del negocio, y cada
 * persona ve solo sus conversaciones.
 *
 * Escribir es siempre en «la vigente de quien pregunta»: ninguna ruta que
 * escribe recibe un id. Leer una archivada sí lo recibe, y el servicio lo
 * busca entre las de esa persona: un id ajeno da 404.
 */
@Controller('conversacion')
@ExigeEmpresa()
@Roles(...ROLES)
export class ConversacionController {
  constructor(
    private readonly conversacion: ConversacionService,
    private readonly propuestas: PropuestasService,
    private readonly pendientes: PendientesService,
    // `@Optional()` por lo mismo que en el servicio: las pruebas que arman
    // este controlador a mano no tienen por qué saber de pausas.
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  /**
   * Si se puede conversar. Depende de la clave del modelo —no del bucket— y
   * de que el chat no esté en pausa para esta empresa.
   *
   * La pausa entra acá y no solo en el momento de preguntar porque si no, la
   * pantalla se abre entera y normal y recién falla cuando alguien escribe.
   * Preguntándolo antes, el asistente se muestra dormido desde el principio,
   * que es lo que de verdad está pasando.
   */
  @Get('disponible')
  async disponible(
    @ActorEmpresa() ctx: CtxEmpresa,
  ): Promise<{ disponible: boolean; motivo?: 'SIN_CLAVE' | 'EN_PAUSA' }> {
    // El motivo viaja porque las dos causas se arreglan en lugares distintos:
    // una la resuelve quien administra el servidor y la otra quien maneja la
    // plataforma. Decir «falta configurarla» cuando en realidad la pausaron
    // manda a la persona a buscar donde no es.
    if (!this.conversacion.disponible) {
      return { disponible: false, motivo: 'SIN_CLAVE' };
    }
    if ((await this.pausa?.pausada(ctx.tenantId, 'CHAT')) ?? false) {
      return { disponible: false, motivo: 'EN_PAUSA' };
    }
    return { disponible: true };
  }

  @Get()
  vigente(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.conversacion.vigente(ctx);
  }

  /**
   * Confirmar lo que el asistente propuso (paso 7). Todos los roles llegan
   * acá, pero el servicio mira **los del endpoint que hace la acción**
   * —cobrar es de CAJA y DIRECTOR—, y solo quien pidió la puede confirmar.
   * `correccion` es lo que la persona cambió en la tarjeta.
   */
  @Post('propuestas/:id/confirmar')
  @HttpCode(200)
  confirmar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarPropuestaDto,
  ) {
    return this.propuestas.confirmar(ctx, id, dto.correccion);
  }

  @Post('propuestas/:id/descartar')
  @HttpCode(200)
  descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.propuestas.descartar(ctx, id);
  }

  /**
   * Lo que espera una decisión de quien pregunta: el número de la barra lateral
   * y la píldora del encabezado. Antes de `:id`, que si no se tragaría la ruta.
   */
  @Get('pendientes')
  pendientesDe(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.pendientes.contar(ctx);
  }

  /** «María esta semana», la tarjeta del tablero. También antes de `:id`. */
  @Get('semana')
  semana(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.pendientes.semana(ctx);
  }

  /** Todas las de quien pregunta, para la columna de la izquierda. */
  @Get('lista')
  lista(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.conversacion.lista(ctx);
  }

  /** Una, para leerla. Las archivadas no se retoman: se empieza otra. */
  @Get(':id')
  una(@ActorEmpresa() ctx: CtxEmpresa, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversacion.una(ctx, id);
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
   *   `CONSULTA` — el asistente está consultando datos: «Cartera»,
   *                «Saldos de caja y bancos». Para que la pantalla no se
   *                quede quieta los segundos que tarda;
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
        alConsultar: (etiqueta) => enviar({ tipo: 'CONSULTA', etiqueta }),
        corte: corte.signal,
      });
      enviar({ tipo: 'FIN', turno: respuesta });
    } catch {
      // La respuesta del modelo ya se tradujo a un estado; lo que llega acá es
      // una falla al guardar. El flujo ya está abierto: no hay código HTTP que
      // mandar, así que se dice con un evento.
      enviar({
        tipo: 'ERROR',
        motivo: 'No pude guardar la respuesta. Recargue la conversación.',
      });
    } finally {
      res.end();
    }
  }
}
