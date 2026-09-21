import type {
  TurnoParaModelo,
  UsoConversacion,
} from '../proveedores/conversador.puerto';

/**
 * Las reglas de la conversación que no dependen del modelo ni de la base.
 * Puras, para probarlas sin red.
 */

/** Un turno como está guardado: con su estado, que decide si viaja al modelo. */
export interface TurnoGuardado {
  autor: 'PERSONA' | 'ASISTENTE';
  texto: string;
  estado: 'COMPLETO' | 'CORTADO' | 'RECHAZADO' | 'FALLO';
}

/**
 * Los tokens de entrada por turno a partir de los cuales el asistente deja de
 * seguir el mismo hilo y propone empezar otro (paso 4, pregunta 1). No recorta
 * en silencio: recortar cambiaría el comienzo del prompt, tiraría el caché
 * entero y además el asistente olvidaría. Es un punto de partida; lo ajusta lo
 * que mida `scripts/conversar.ts`.
 */
export const TOPE_TOKENS_ENTRADA = 60_000;

/**
 * Tarifas de `claude-opus-5` por millón de tokens, del catálogo público. La
 * lectura de caché es una décima de la entrada; la escritura, 1,25 veces. Si
 * cambian, la cuenta de plata queda vieja y los tokens guardados siguen siendo
 * ciertos: por eso se guarda `uso` y no el costo.
 */
export const USD_POR_MILLON = {
  entrada: 5,
  salida: 25,
  cacheLeido: 0.5,
  cacheEscrito: 6.25,
} as const;

/**
 * Lo que se le manda al modelo, de todo lo guardado.
 *
 * - Un turno del asistente `RECHAZADO` o `FALLO` no viaja: no contestó nada, y
 *   mandarle «no pude» como si lo hubiera dicho él lo confunde.
 * - Un `CORTADO` sí viaja con lo que alcanzó: es lo que la persona leyó.
 * - Un texto vacío no viaja.
 * - El hilo empieza siempre por la persona: la API lo exige.
 *
 * Dos preguntas seguidas de la persona —la del medio quedó sin respuesta—
 * viajan así, seguidas: la API las junta en un solo turno.
 */
export function hiloParaModelo(
  turnos: readonly TurnoGuardado[],
): TurnoParaModelo[] {
  const hilo = turnos
    .filter(
      (t) =>
        t.texto.trim() !== '' &&
        !(
          t.autor === 'ASISTENTE' &&
          (t.estado === 'RECHAZADO' || t.estado === 'FALLO')
        ),
    )
    .map((t) => ({ autor: t.autor, texto: t.texto }));

  const primeraPersona = hilo.findIndex((t) => t.autor === 'PERSONA');
  return primeraPersona < 0 ? [] : hilo.slice(primeraPersona);
}

/** Todo lo que entró en la llamada: lo nuevo, más lo que se escribió y se leyó del caché. */
export function entradaTotal(uso: UsoConversacion): number {
  return uso.entrada + uso.cacheEscrito + uso.cacheLeido;
}

/**
 * Si el hilo ya no da para otro turno. Se mide con el uso real de la última
 * respuesta, que es lo que el hilo pesa de verdad, y no con una estimación.
 * Sin uso —el primer turno, o una respuesta que falló— no hay tope que medir.
 */
export function superaTope(
  ultimoUso: UsoConversacion | null,
  tope: number = TOPE_TOKENS_ENTRADA,
): boolean {
  return ultimoUso !== null && entradaTotal(ultimoUso) >= tope;
}

/** Cuánto costó una llamada, en dólares. Para el registro y el script de medición. */
export function costoUsd(uso: UsoConversacion): number {
  return (
    (uso.entrada * USD_POR_MILLON.entrada +
      uso.salida * USD_POR_MILLON.salida +
      uso.cacheLeido * USD_POR_MILLON.cacheLeido +
      uso.cacheEscrito * USD_POR_MILLON.cacheEscrito) /
    1_000_000
  );
}
