import type { ClavePaso } from '../../nucleo/servicios/estado-configuracion.reglas';
import type {
  Comprobacion,
  FacturaCompraLeida,
} from '../reglas/factura-compra.reglas';
import type { PedidoLeido } from '../reglas/pedido-venta.reglas';
import type { VentaHistoricaLeida } from '../reglas/venta-historica.reglas';

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
 * Los tres documentos con los que se configura una empresa. Devuelven **campos
 * sueltos**: una lista de `campo · valor` que alimenta un paso del asistente.
 */
export type TipoDocumentoConfiguracion =
  'RUT' | 'CAMARA_COMERCIO' | 'RESOLUCION_DIAN';

/**
 * Todo lo que se puede leer. Mismo juego de valores que la columna
 * `documento_leido.tipo` (0048 y 0061).
 *
 * La factura va aparte del resto en los tipos y no solo en el nombre, porque
 * **no devuelve campos sueltos**: devuelve una cabecera con renglones adentro.
 * Tenerlas en un solo tipo dejaría que `leer()` acepte una factura y conteste
 * `DatoExtraido[]`, que es la forma en la que dos renglones de la misma factura
 * se pisan.
 */
export type TipoDocumento =
  | TipoDocumentoConfiguracion
  | 'FACTURA_COMPRA'
  | 'PEDIDO_VENTA'
  | 'VENTA_HISTORICA';

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
  fuente: { documento: TipoDocumentoConfiguracion; casilla?: string };
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
  documento: TipoDocumentoConfiguracion;
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

/**
 * Una lectura que no salió, sea de un RUT o de una factura. Es la misma forma
 * para las dos porque las razones por las que no se puede leer un archivo no
 * dependen de qué archivo es: la clave, la red, el formato, «Detener».
 */
export interface FallaLectura {
  leido: false;
  clase: ClaseDeFalla;
  motivo: string;
  /** Si la API alcanzó a contestar —y a cobrar— antes de la falla. */
  medicion?: MedicionLectura;
}

export type ResultadoLectura =
  | { leido: true; datos: DatoExtraido[]; medicion: MedicionLectura }
  | FallaLectura;

/**
 * Lo que salió de leer una factura.
 *
 * Trae las comprobaciones al lado y no un `cuadra: boolean`, porque cuando algo
 * no da hay que poder decir **qué** no dio: «los renglones suman 3.485.293 y el
 * documento dice 3.585.293» es accionable, «no cuadra» no.
 */
export type ResultadoLecturaFactura =
  | {
      leido: true;
      factura: FacturaCompraLeida;
      /** Las sumas del código contra los totales impresos. */
      comprobaciones: Comprobacion[];
      medicion: MedicionLectura;
    }
  | FallaLectura;

/**
 * Lo que salió de leer el pedido de un cliente. Las comprobaciones pueden venir
 * vacías: un pedido sin precios ni subtotal no tiene contra qué sumarse.
 */
export type ResultadoLecturaPedido =
  | {
      leido: true;
      pedido: PedidoLeido;
      comprobaciones: Comprobacion[];
      medicion: MedicionLectura;
    }
  | FallaLectura;

/**
 * Las facturas de venta del sistema anterior que traía un archivo, cada una con
 * sus comprobaciones al lado (fase 11).
 */
export type ResultadoLecturaVentas =
  | {
      leido: true;
      facturas: Array<{
        factura: VentaHistoricaLeida;
        comprobaciones: Comprobacion[];
      }>;
      medicion: MedicionLectura;
    }
  | FallaLectura;

export interface ExtractorPuerto {
  /**
   * `false` cuando falta la clave. El modo IA entonces no se ofrece y el
   * asistente manual sigue igual, como ya pasa con el bucket y las imágenes de
   * producto.
   */
  readonly disponible: boolean;

  leer(entrada: {
    tipo: TipoDocumentoConfiguracion;
    archivo: ArchivoParaLeer;
    /** Se llama en cada avance. Sin esto la lectura funciona igual, muda. */
    alAvanzar?: (avance: AvanceLectura) => void;
    /** «Detener» del §7.7 de la guía. */
    corte?: AbortSignal;
  }): Promise<ResultadoLectura>;

  /**
   * Una factura de compra. Va aparte de `leer` y no como un tipo más, porque lo
   * que devuelve es de otra forma —cabecera con renglones— y porque **se
   * comprueba**: el código suma los renglones y los compara contra los totales
   * impresos. Eso no se puede hacer con un RUT.
   *
   * Sin avances: una factura se lee de una y en segundos, y mostrar renglones a
   * medio llegar invitaría a leerlos antes de que el total esté comprobado.
   */
  leerFactura(entrada: {
    archivo: ArchivoParaLeer;
    corte?: AbortSignal;
  }): Promise<ResultadoLecturaFactura>;

  /**
   * El pedido de un cliente, para armar la factura de venta. Misma forma de
   * llamada que la factura de compra —herramienta forzada, sin avances—, con
   * su propio esquema: lo que importa acá son las cantidades, no los precios.
   */
  leerPedido(entrada: {
    archivo: ArchivoParaLeer;
    corte?: AbortSignal;
  }): Promise<ResultadoLecturaPedido>;

  /**
   * Las facturas de venta que la empresa emitió en el sistema anterior. Un
   * archivo puede traer varias; cada una se comprueba contra sus totales.
   */
  leerVentasHistoricas(entrada: {
    archivo: ArchivoParaLeer;
    corte?: AbortSignal;
  }): Promise<ResultadoLecturaVentas>;

  /**
   * Qué es un archivo cualquiera —PDF, foto, Excel, Word, texto—, dicho en
   * palabras. Si es algo que ella lee —los tres de configuración, una factura
   * de compra o el pedido de un cliente—, `tipo` lo dice y la lectura sigue.
   * Es una llamada corta y aparte.
   *
   * `empresa` es quien usa el sistema: sin saberlo no se distingue una factura
   * que un proveedor le emitió de una que ella misma emitió.
   */
  analizar(
    archivo: ArchivoParaLeer,
    empresa?: { razonSocial: string; nit: string },
  ): Promise<AnalisisArchivo>;

  /**
   * La identidad de una empresa que todavía no existe, desde su RUT: para que
   * una cuenta nueva pueda elegir «Con IA» antes de crearla. Llamada corta.
   */
  identificarEmpresa(archivo: ArchivoParaLeer): Promise<IdentidadEmpresa>;
}

/**
 * Quién es la empresa, leído de su RUT **antes de que exista en el sistema**:
 * lo justo para crearla. El resto del RUT se lee después, ya con la empresa,
 * por el camino de siempre.
 */
export interface IdentidadEmpresa {
  /** `false` si el archivo no es un RUT: entonces lo demás viene vacío. */
  esRut: boolean;
  razonSocial: string | null;
  /** Solo dígitos, sin el de verificación. */
  nit: string | null;
  dv: string | null;
  tipoPersona: 'JURIDICA' | 'NATURAL' | null;
  /** Una frase para la persona: qué se leyó, o por qué no. */
  resumen: string;
  medicion?: MedicionLectura;
}

/** Lo que dice el asistente de un archivo que se le subió sin decir qué es. */
export interface AnalisisArchivo {
  /** Algo que María lee, o `null`. */
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
