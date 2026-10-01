import type { Tokens } from '../../../common/ia/modelos';
import type { EntradaClasificador } from '../reglas/clasificador-ia.reglas';

/** Lo que contestó el modelo, sin validar: lo valida `validarRespuesta`. */
export interface RespuestaClasificador {
  respuesta: unknown;
  modelo: string;
  uso: Tokens;
  duracionMs: number;
}

/**
 * La IA que propone un concepto de retención (fuente 5). Se registra por este
 * token y no por su clase: las pruebas ponen uno de mentira.
 */
export interface ClasificadorPuerto {
  /** Si hay clave de la API. Sin ella, la fuente 5 no existe y se pregunta. */
  readonly disponible: boolean;
  /** `null` si el modelo no contestó. Nunca lanza. */
  clasificar(e: EntradaClasificador): Promise<RespuestaClasificador | null>;
}

export const CLASIFICADOR_PUERTO = Symbol('CLASIFICADOR_PUERTO');
