/**
 * Redondea como `round(numeric, n)` de Postgres: en decimal y la mitad lejos
 * del cero.
 *
 * `Math.round(valor * 100) / 100` no basta: un `number` es binario y no guarda
 * exacto 312183.475 (10 × 31218.3475), sino 312183.47499…; JavaScript da .47
 * y Postgres .48. Las reglas de la base (`ck_movimiento_valor_total`:
 * `valor_total = round(cantidad * costo_unitario, 2)`) rechazan ese centavo.
 *
 * Por eso primero se quita el ruido binario (15 cifras significativas, lo que
 * un `number` guarda sin error) y se corre la coma en texto, no multiplicando.
 */
export function redondearDecimal(valor: number, decimales: number): number {
  if (!Number.isFinite(valor) || valor === 0) return valor === 0 ? 0 : valor;
  const signo = valor < 0 ? -1 : 1;
  const escalado = Math.round(
    correrComa(Number(Math.abs(valor).toPrecision(15)), decimales),
  );
  const resultado = signo * correrComa(escalado, -decimales);
  return resultado === 0 ? 0 : resultado;
}

/** `valor × 10^posiciones` sin multiplicar: mueve el exponente del texto. */
function correrComa(valor: number, posiciones: number): number {
  const [mantisa, exponente = '0'] = String(valor).split('e');
  return Number(`${mantisa}e${Number(exponente) + posiciones}`);
}
