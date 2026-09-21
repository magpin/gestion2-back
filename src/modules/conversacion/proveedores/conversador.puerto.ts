/**
 * Lo que el módulo `conversacion` necesita de un modelo, en castellano y sin
 * nada del SDK. El adaptador de Claude implementa esto; las pruebas y el
 * servicio solo conocen esto.
 *
 * Mismo criterio que `extractor.puerto.ts` en `lectura-documentos`: el día que
 * el modelo cambie, cambia un archivo.
 */

/** Un turno del hilo, tal como se le manda al modelo. */
export interface TurnoParaModelo {
  autor: 'PERSONA' | 'ASISTENTE';
  texto: string;
}

/**
 * Los tokens de una llamada, con los nombres de la casa. Son los cuatro que
 * hacen falta para decir cuánto costó: el caché se cobra distinto al escribir
 * que al leer.
 */
export interface UsoConversacion {
  entrada: number;
  salida: number;
  cacheEscrito: number;
  cacheLeido: number;
}

/**
 * Cómo terminó una respuesta. Los cuatro estados son los de
 * `conversacion_turno.estado` (migración 0050), y el servicio guarda esto tal
 * cual.
 *
 * - `COMPLETO`: contestó entero.
 * - `CORTADO`: se detuvo a mitad —la persona cerró, o se llegó al tope de
 *   salida—. `texto` es lo que alcanzó a escribirse.
 * - `RECHAZADO`: el modelo y su respaldo declinaron. Lo que se haya escrito se
 *   descarta: una respuesta a medias de algo que se rechazó no es respuesta.
 * - `FALLO`: la API no respondió, o respondió con error. `clase` es para el
 *   registro y para decidir si mostrar «probá en un rato»; `motivo` es para la
 *   persona.
 */
export type ResultadoRespuesta =
  | { estado: 'COMPLETO'; texto: string; modelo: string; uso: UsoConversacion }
  | {
      estado: 'CORTADO';
      texto: string;
      modelo: string;
      uso: UsoConversacion | null;
      motivo: string | null;
    }
  | {
      estado: 'RECHAZADO';
      modelo: string;
      uso: UsoConversacion | null;
      motivo: string;
    }
  | {
      estado: 'FALLO';
      clase: 'SIN_CLAVE' | 'NO_DISPONIBLE' | 'PETICION' | 'FALLA';
      motivo: string;
    };

/**
 * Lo que el modelo puede consultar en este turno (paso 6 de
 * `asistente-conversacion.md`). Lo arma el servicio con los roles de quien
 * pregunta; el adaptador solo las ofrece y las ejecuta cuando el modelo las
 * pide, sin saber qué hacen.
 */
export interface HerramientasDelTurno {
  /** Nombre, descripción y esquema de cada una, como las espera el modelo. */
  definiciones: readonly {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }[];
  /**
   * Corre una. Devuelve el texto que lee el modelo; un error de la consulta
   * también vuelve como texto, para que el modelo lo lea y corrija. Solo
   * rechaza por una falla que no es de la consulta.
   */
  ejecutar(nombre: string, entrada: unknown): Promise<string>;
}

export interface ConversadorPuerto {
  /** Si hay con qué conversar. Solo depende de la clave: no del bucket. */
  readonly disponible: boolean;

  /**
   * Contesta la última pregunta del hilo. `alEscribir` recibe cada pedazo de
   * texto a medida que el modelo lo escribe: es lo que la pantalla muestra en
   * vivo. `corte` detiene la llamada (la persona cerró la pestaña).
   *
   * Con `herramientas`, el modelo puede consultar antes de contestar: hasta
   * `CONSULTAS_POR_TURNO` vueltas, y después contesta con lo que tiene.
   * `alConsultar` avisa cada consulta cuando empieza, para que la pantalla
   * diga «Consultando cartera…» en vez de quedarse quieta.
   */
  responder(entrada: {
    hilo: TurnoParaModelo[];
    alEscribir?: (trozo: string) => void;
    corte?: AbortSignal;
    herramientas?: HerramientasDelTurno;
    alConsultar?: (nombre: string, entrada: unknown) => void;
    /**
     * Lo que el sistema le dice al modelo en este turno, fuera del hilo: hoy,
     * las reglas de autonomía vigentes (paso 8). Va con las instrucciones y no
     * dentro de una consulta, porque lo que devuelve una consulta es dato, y
     * el modelo —con razón— no lo obedece.
     */
    contexto?: string;
  }): Promise<ResultadoRespuesta>;
}

export const CONVERSADOR = Symbol('CONVERSADOR');
