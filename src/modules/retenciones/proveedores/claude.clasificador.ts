import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { modeloPara } from '../../../common/ia/modelos';
import {
  ESQUEMA_CLASIFICADOR,
  INSTRUCCIONES_CLASIFICADOR,
  mensajeClasificador,
  type EntradaClasificador,
} from '../reglas/clasificador-ia.reglas';
import type {
  ClasificadorPuerto,
  RespuestaClasificador,
} from './clasificador.puerto';

/**
 * El único archivo del módulo `retenciones` que importa el SDK de Anthropic.
 *
 * El modelo sale de `MODELO_RETENCIONES`: elegir un concepto de una lista
 * cerrada es poco trabajo, y lo que devuelve lo valida el código.
 */
const MODELO = modeloPara('RETENCIONES');

const HERRAMIENTA = {
  name: 'proponer_concepto',
  description:
    'Propone el concepto de retención en la fuente de un renglón, de la lista cerrada.',
  input_schema: ESQUEMA_CLASIFICADOR,
};

@Injectable()
export class ClaudeClasificador implements ClasificadorPuerto {
  private readonly log = new Logger(ClaudeClasificador.name);
  private anthropic: Anthropic | undefined;

  get disponible(): boolean {
    return (process.env.ANTHROPIC_API_KEY ?? '') !== '';
  }

  async clasificar(
    e: EntradaClasificador,
  ): Promise<RespuestaClasificador | null> {
    if (!this.disponible) return null;
    const empezo = Date.now();
    try {
      const respuesta = await this.cliente().messages.create({
        model: MODELO,
        max_tokens: 600,
        system: INSTRUCCIONES_CLASIFICADOR,
        tools: [HERRAMIENTA],
        tool_choice: { type: 'tool', name: HERRAMIENTA.name },
        messages: [{ role: 'user', content: mensajeClasificador(e) }],
      });
      const bloque = respuesta.content.find((b) => b.type === 'tool_use');
      const medicion: RespuestaClasificador = {
        respuesta: bloque?.input ?? null,
        modelo: respuesta.model,
        uso: {
          entrada: respuesta.usage.input_tokens,
          salida: respuesta.usage.output_tokens,
          cacheLeido: respuesta.usage.cache_read_input_tokens ?? 0,
          cacheEscrito: respuesta.usage.cache_creation_input_tokens ?? 0,
        },
        duracionMs: Date.now() - empezo,
      };
      this.log.log(
        `Concepto propuesto en ${medicion.duracionMs} ms · entrada ${medicion.uso.entrada}, salida ${medicion.uso.salida}`,
      );
      return medicion;
    } catch (error: unknown) {
      this.log.warn(
        `El clasificador no contestó: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Aparte para que una prueba pueda poner un cliente de mentira. */
  protected crearCliente(): Anthropic {
    return new Anthropic();
  }

  private cliente(): Anthropic {
    this.anthropic ??= this.crearCliente();
    return this.anthropic;
  }
}
