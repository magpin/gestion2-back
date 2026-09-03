/**
 * Normaliza lo que devuelve `EntityManager.query`.
 *
 * TypeORM no responde igual según la sentencia:
 *
 *   SELECT ... RETURNING?  → `[fila, fila, ...]`
 *   INSERT ... RETURNING   → `[fila, fila, ...]`
 *   UPDATE ... RETURNING   → `[[fila, ...], cantidad]`
 *   DELETE ... RETURNING   → `[[fila, ...], cantidad]`
 *
 * La diferencia es silenciosa y cara. `const [fila] = await query('UPDATE ...')`
 * parece correcto y compila, pero deja en `fila` el arreglo entero: las
 * comprobaciones de "no encontrado" dejan de dispararse —un arreglo vacío no es
 * `undefined`— y cualquier campo que se lea sale `undefined`.
 *
 * En este sistema eso llegó a importar de verdad: `tomarConsecutivo` leía
 * `consecutivo_actual` del resultado de un UPDATE y habría numerado facturas
 * con `NaN`.
 */
export function filas<T>(resultado: unknown): T[] {
  if (
    Array.isArray(resultado) &&
    resultado.length === 2 &&
    Array.isArray(resultado[0]) &&
    typeof resultado[1] === 'number'
  ) {
    return resultado[0] as T[];
  }
  return (resultado ?? []) as T[];
}

/** La primera fila, o `undefined` si no hubo ninguna. */
export function fila<T>(resultado: unknown): T | undefined {
  return filas<T>(resultado)[0];
}
