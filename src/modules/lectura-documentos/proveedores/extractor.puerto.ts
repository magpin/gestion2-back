import type { ClavePaso } from '../../nucleo/servicios/estado-configuracion.reglas';

/**
 * La frontera del módulo con el mundo de afuera.
 *
 * Todo lo que sabe el resto de `lectura-documentos` de cómo se lee un documento
 * está en este archivo. El único que lo implementa hoy es `claude.proveedor.ts`,
 * y es también el único que importa el SDK de Anthropic. No es ceremonia: es lo
 * que permite probar el módulo entero sin red, y lo que hace real la frontera
 * del «falla por sus propias razones».
 */

/**
 * Los tres documentos que el asistente pide tener a mano. Mismo juego de valores
 * que la columna `documento_leido.tipo` (0048).
 */
export type TipoDocumento = 'RUT' | 'CAMARA_COMERCIO' | 'RESOLUCION_DIAN';

/**
 * `DUDOSA` **no se aplica nunca**: va a la lista de preguntas. Es el mismo
 * principio del plan de cuentas —lo que no se puede deducir no se inventa—, y
 * acá importa más, porque del otro lado hay un RUT real.
 */
export type Confianza = 'ALTA' | 'DUDOSA';

/** Un hecho que el documento propone, todavía sin aplicar. */
export interface DatoExtraido {
  /** A qué paso del asistente alimenta. */
  paso: ClavePaso;
  /** El nombre del campo, tal como lo espera el endpoint manual. */
  campo: string;
  valor: unknown;
  /**
   * Lo que la pantalla muestra a la izquierda. **Lo decide el catálogo de
   * `documento.reglas.ts`, no el modelo**: una etiqueta venida del documento
   * sería texto de un tercero pintado en nuestra interfaz.
   */
  etiqueta: string;
  /** De dónde salió. Es lo que permite discutir un dato sin abrir el PDF. */
  fuente: { documento: TipoDocumento; casilla?: string };
  confianza: Confianza;
}

/** El archivo, ya bajado del bucket. */
export interface ArchivoParaLeer {
  /** Cualquiera de `TIPOS_SUBIBLES` (`reglas/contenido.ts`). `leer` acepta solo PDF e imágenes. */
  tipoMime: string;
  contenido: Buffer;
}

/**
 * Un avance de la lectura. Sale de un hecho —empezó, llegaron datos, terminó—,
 * nunca de un temporizador: el §7.5 de la guía lo exige y es fácil hacer trampa
 * acá.
 */
export interface AvanceLectura {
  etapa: 'LEYENDO' | 'EXTRAYENDO' | 'LISTO';
  documento: TipoDocumento;
  /** Una línea para el rótulo de la pantalla. */
  mensaje: string;
  /** Lo que llegó con este avance. Vacío cuando el avance no trae datos. */
  datos: DatoExtraido[];
}

/**
 * Por qué no se pudo leer. El texto que ve la persona va en `motivo`; esto es
 * para decidir qué hacer y para el registro.
 *
 * - `SIN_CLAVE`: no hay `ANTHROPIC_API_KEY`, o no sirve. El modo IA no se ofrece.
 * - `NO_DISPONIBLE`: la API está caída, sin red o se agotó el límite. Se reintenta.
 * - `ILEGIBLE`: el archivo no se puede leer, o no es del tipo que dice ser.
 * - `DECLINADO`: el modelo declinó la petición, y el respaldo también.
 * - `CORTADO`: la respuesta se cortó antes de terminar.
 * - `DETENIDO`: una persona apretó «Detener».
 * - `FALLA`: cualquier otra cosa. Se registra completa y se cuenta corta.
 */
export type ClaseDeFalla =
  | 'SIN_CLAVE'
  | 'NO_DISPONIBLE'
  | 'ILEGIBLE'
  | 'DECLINADO'
  | 'CORTADO'
  | 'DETENIDO'
  | 'FALLA';

/** Lo que costó la lectura. Se registra: el gasto crece con cada empresa nueva. */
export interface UsoLectura {
  entrada: number;
  salida: number;
  /** Los tokens que se sirvieron del caché del prompt. */
  cacheLeido: number;
  /** Los que se escribieron en el caché: se cobran más caros que la entrada. */
  cacheEscrito: number;
}

/**
 * Lo que costó una lectura: se guarda con el documento para el tablero de
 * consumo (`docs/planes/consumo-ia.md`, migración 0054).
 */
export interface MedicionLectura {
  uso: UsoLectura;
  /** El que contestó, que con el respaldo por rechazo puede no ser el pedido. */
  modelo: string;
  duracionMs: number;
}

export type ResultadoLectura =
  | { leido: true; datos: DatoExtraido[]; medicion: MedicionLectura }
  | {
      leido: false;
      clase: ClaseDeFalla;
      motivo: string;
      /** Si la API alcanzó a contestar —y a cobrar— antes de la falla. */
      medicion?: MedicionLectura;
    };

export interface ExtractorPuerto {
  /**
   * `false` cuando falta la clave. El modo IA entonces no se ofrece y el
   * asistente manual sigue igual, como ya pasa con el bucket y las imágenes de
   * producto.
   */
  readonly disponible: boolean;

  leer(entrada: {
    tipo: TipoDocumento;
    archivo: ArchivoParaLeer;
    /** Se llama en cada avance. Sin esto la lectura funciona igual, muda. */
    alAvanzar?: (avance: AvanceLectura) => void;
    /** «Detener» del §7.7 de la guía. */
    corte?: AbortSignal;
  }): Promise<ResultadoLectura>;

  /**
   * Qué es un archivo cualquiera —PDF, foto, Excel, Word, texto—, dicho en
   * palabras. Si es uno de los tres que se leen para configurar la empresa,
   * `tipo` lo dice y la lectura sigue por `leer`. Es una llamada corta y aparte.
   */
  analizar(archivo: ArchivoParaLeer): Promise<AnalisisArchivo>;
}

/** Lo que dice el asistente de un archivo que se le subió sin decir qué es. */
export interface AnalisisArchivo {
  /** Uno de los que se leen para configurar la empresa, o `null`. */
  tipo: TipoDocumento | null;
  /** Qué es, en dos o tres palabras: «Factura de compra», «Extracto bancario». */
  clase: string;
  /** Qué dice, para el dueño: de quién, fechas y montos principales. */
  resumen: string;
  /** Sin medición cuando no se llamó al modelo: el formato no se puede abrir. */
  medicion?: MedicionLectura;
}

/** El token con el que Nest inyecta la implementación. */
export const EXTRACTOR_PUERTO = 'EXTRACTOR_PUERTO';
