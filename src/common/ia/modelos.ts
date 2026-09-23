/**
 * Los modelos de Claude que usa el sistema, cuánto cuesta cada uno y cuál se
 * usa para cada cosa (`docs/planes/consumo-ia.md`, entrega C2).
 *
 * **El costo no se guarda: se calcula** con los tokens guardados y el modelo de
 * cada fila. Si cambia una tarifa, cambia esta tabla y el tablero recalcula
 * todo; los tokens siguen siendo ciertos.
 */

/** Tokens de una llamada, con los nombres de la casa. */
export interface Tokens {
  entrada: number;
  salida: number;
  cacheLeido: number;
  cacheEscrito: number;
}

/** US$ por millón de tokens. */
export interface Tarifa {
  entrada: number;
  salida: number;
  cacheLeido: number;
  /** Escritura del caché de 5 minutos: 1,25 × la entrada. */
  cacheEscrito: number;
  /** Lo más corto que se cachea: un prefijo menor se relee a precio completo. */
  minimoCache: number;
}

/**
 * Precio de lista de la API de Anthropic.
 *
 * **Verificar Sonnet 5 en la página de precios antes de decidir con él**: sus
 * cifras vienen de `docs/planes/costo-ia-modelos.md` y no están confirmadas.
 * Opus 5 es el que se midió en los pasos 4b y 6a.
 */
export const TARIFAS: Readonly<Record<'OPUS' | 'SONNET' | 'HAIKU', Tarifa>> = {
  OPUS: {
    entrada: 5,
    salida: 25,
    cacheLeido: 0.5,
    cacheEscrito: 6.25,
    minimoCache: 512,
  },
  SONNET: {
    entrada: 2,
    salida: 10,
    cacheLeido: 0.2,
    cacheEscrito: 2.5,
    minimoCache: 1024,
  },
  HAIKU: {
    entrada: 1,
    salida: 5,
    cacheLeido: 0.1,
    cacheEscrito: 1.25,
    minimoCache: 4096,
  },
};

/**
 * La tarifa de un modelo por su nombre. La API contesta con el nombre del que
 * respondió —con el respaldo por rechazo puede no ser el pedido—, así que se
 * reconoce por la familia. Uno desconocido se cobra como Opus: es mejor
 * sobrestimar que esconder un costo.
 */
export function tarifaDe(modelo: string | null | undefined): Tarifa {
  const m = (modelo ?? '').toLowerCase();
  if (m.includes('haiku')) return TARIFAS.HAIKU;
  if (m.includes('sonnet')) return TARIFAS.SONNET;
  return TARIFAS.OPUS;
}

/** Lo que costó una llamada, en US$. */
export function costoUsd(t: Tokens, modelo?: string | null): number {
  const tarifa = tarifaDe(modelo);
  return (
    (t.entrada * tarifa.entrada +
      t.salida * tarifa.salida +
      t.cacheLeido * tarifa.cacheLeido +
      t.cacheEscrito * tarifa.cacheEscrito) /
    1_000_000
  );
}

/**
 * Lo que habría costado la misma llamada con otra tarifa. Es una simulación:
 * dice cuánto se ahorraría, **no si la calidad alcanza**.
 *
 * Con un mínimo de caché mayor que el prefijo, lo que se leyó o escribió en el
 * caché se paga como entrada normal: es lo que le pasa a Haiku con prefijos de
 * menos de 4.096 tokens.
 */
export function costoSimulado(t: Tokens, tarifa: Tarifa): number {
  const prefijo = t.entrada + t.cacheLeido + t.cacheEscrito;
  const cachea = prefijo >= tarifa.minimoCache;
  const entrada = cachea ? t.entrada : prefijo;
  return (
    (entrada * tarifa.entrada +
      t.salida * tarifa.salida +
      (cachea ? t.cacheLeido * tarifa.cacheLeido : 0) +
      (cachea ? t.cacheEscrito * tarifa.cacheEscrito : 0)) /
    1_000_000
  );
}

/** Los modelos que se pueden elegir. Ver `aceptaRazonamiento`: con Haiku cambia la petición, no solo el nombre. */
export const MODELOS_PERMITIDOS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const;
export type ModeloPermitido = (typeof MODELOS_PERMITIDOS)[number];

/**
 * Si el modelo acepta `thinking: { type: 'adaptive' }` y `output_config.effort`.
 *
 * **Haiku 4.5 no**, y mandárselos no degrada la respuesta: la API rechaza la
 * petición entera. Por eso elegir Haiku no es cambiar un nombre, y por eso esto
 * vive acá y no en cada proveedor: son dos, y una de las dos se iba a olvidar.
 *
 * Se decide por familia y no por nombre exacto porque con el respaldo por
 * rechazo el que contesta puede no ser el que se pidió.
 */
export function aceptaRazonamiento(modelo: string): boolean {
  return !modelo.toLowerCase().includes('haiku');
}

/**
 * El modelo por defecto: el que se midió primero y el que pasó todas las
 * pruebas. El chat puede ir en Sonnet con `MODELO_CONVERSACION` (C5 de
 * `consumo-ia.md`).
 */
export const MODELO_POR_DEFECTO: ModeloPermitido = 'claude-opus-5';

/** Para qué se usa el modelo. Cada uso se elige por separado en el entorno. */
export type UsoDelModelo = 'CONVERSACION' | 'LECTURA' | 'FACTURAS';

const VARIABLE: Record<UsoDelModelo, string> = {
  CONVERSACION: 'MODELO_CONVERSACION',
  LECTURA: 'MODELO_LECTURA',
  FACTURAS: 'MODELO_FACTURAS',
};

/**
 * El modelo de un uso, de su variable de entorno o el de por defecto. **Uno
 * que no esté en la lista no arranca**: un nombre mal escrito no puede quedar
 * descubierto recién cuando la API lo rechaza, pregunta por pregunta.
 */
export function modeloPara(uso: UsoDelModelo): ModeloPermitido {
  const valor = process.env[VARIABLE[uso]]?.trim();
  if (valor === undefined || valor === '') return MODELO_POR_DEFECTO;
  if (!(MODELOS_PERMITIDOS as readonly string[]).includes(valor)) {
    throw new Error(
      `${VARIABLE[uso]}=${valor} no es un modelo permitido. Se puede elegir: ${MODELOS_PERMITIDOS.join(', ')}.`,
    );
  }
  return valor as ModeloPermitido;
}
