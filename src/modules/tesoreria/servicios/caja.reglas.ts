/**
 * El saldo corrido de una caja, en memoria. Sin base de datos.
 *
 * Mismo principio que `kardex.reglas.ts`: los `CHECK` de `0033`
 * (`valor > 0`, `saldo_valor >= 0`, `ck_arqueo_diferencia`) ya sostienen la
 * aritmética en la base, pero disparan al COMMIT con un error genérico.
 * Acá se anticipa, para poder señalar qué falta con un mensaje que se
 * entienda.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la
 * base tiene razón.
 */

/**
 * El dinero de un movimiento de caja siempre es pesos con centavos —
 * `numeric(18,2)`, igual que `asiento.total_debito`—. A diferencia del
 * kardex, acá no hay una "cantidad" con decimales configurables por
 * empresa: es plata, y la plata redondea a dos decimales siempre.
 */
const DECIMALES_DINERO = 2;

export function redondear(valor: number, decimales = DECIMALES_DINERO): number {
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

/** Un ingreso siempre se puede registrar: no hay saldo que "se quede corto". */
export function calcularIngreso(saldoActual: number, valor: number): number {
  return redondear(saldoActual + valor);
}

/** Un egreso sí se puede rechazar: dejaría la caja en negativo. */
export type ResultadoEgreso =
  { ok: true; saldo: number } | { ok: false; motivo: string };

export function calcularEgreso(
  saldoActual: number,
  valor: number,
): ResultadoEgreso {
  const nuevoSaldo = redondear(saldoActual - valor);

  if (nuevoSaldo < 0) {
    return {
      ok: false,
      motivo: `Solo hay ${saldoActual} en caja; no se puede sacar ${valor}.`,
    };
  }

  return { ok: true, saldo: nuevoSaldo };
}

/**
 * La diferencia de un arqueo: lo contado menos lo que el sistema decía.
 * Positiva es sobrante, negativa es faltante — mismo signo que
 * `ck_arqueo_diferencia` en la base.
 */
export function calcularDiferenciaArqueo(
  saldoSistema: number,
  saldoContado: number,
): number {
  return redondear(saldoContado - saldoSistema);
}

/**
 * Si se puede abrir un arqueo nuevo para esta caja.
 *
 * Anticipa `ux_arqueo_abierto`: sin esto, la base rechaza el `INSERT` con
 * una violación de índice único que no dice en palabras qué arqueo hay que
 * cerrar primero.
 */
export function verificarPuedeAbrirArqueo(
  hayArqueoAbierto: boolean,
): { ok: true } | { ok: false; motivo: string } {
  if (hayArqueoAbierto) {
    return {
      ok: false,
      motivo:
        'Ya hay un arqueo abierto para esta caja. Cerralo antes de abrir uno nuevo.',
    };
  }
  return { ok: true };
}
