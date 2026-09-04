/**
 * Partida doble en memoria. Sin base de datos.
 *
 * Los triggers de `0022` ya sostienen estas reglas, pero disparan al COMMIT y
 * hablan del asiento entero: "faltan $12.000" no dice cuál de las nueve líneas
 * está mal. Acá se valida antes de ir al servidor para poder señalar el renglón.
 *
 * No reemplazan al trigger: lo anticipan. Si esto y la base discrepan, la base
 * tiene razón.
 */

export type Naturaleza = 'DEBITO' | 'CREDITO';

/** Lo mínimo para validar una línea. El servicio pasa más campos y no estorban. */
export interface LineaCuadrable {
  debito: number;
  credito: number;
}

/** El dinero se compara en centavos enteros. */
const CENTAVOS = 100;

/**
 * Suma en centavos para no comparar flotantes.
 *
 * `0.1 + 0.2 !== 0.3` en punto flotante, y un asiento de $0.1 contra $0.2 y $0.3
 * quedaría descuadrado por una diferencia que no existe. La base usa
 * `numeric(18,2)`, que sí es exacto; acá se replica redondeando a centavos.
 */
function aCentavos(valor: number): number {
  return Math.round(valor * CENTAVOS);
}

function aPesos(centavos: number): number {
  return centavos / CENTAVOS;
}

export interface Cuadre {
  cuadra: boolean;
  totalDebito: number;
  totalCredito: number;
  /** Siempre positiva. Cuánto falta del lado que dice `falta`. */
  diferencia: number;
  /** De qué lado falta plata. `null` cuando cuadra. */
  falta: Naturaleza | null;
}

/**
 * Si el asiento cuadra, y de qué lado falta cuando no.
 *
 * Decir solo "no cuadra" obliga a sumar a mano las dos columnas para saber para
 * dónde corregir.
 */
export function verificarCuadre(lineas: readonly LineaCuadrable[]): Cuadre {
  const debito = lineas.reduce((t, l) => t + aCentavos(l.debito), 0);
  const credito = lineas.reduce((t, l) => t + aCentavos(l.credito), 0);
  const diferencia = debito - credito;

  return {
    cuadra: diferencia === 0,
    totalDebito: aPesos(debito),
    totalCredito: aPesos(credito),
    diferencia: aPesos(Math.abs(diferencia)),
    // Si el débito es mayor, lo que falta es crédito.
    falta: diferencia === 0 ? null : diferencia > 0 ? 'CREDITO' : 'DEBITO',
  };
}

/**
 * Qué líneas no llevan exactamente una pata.
 *
 * Devuelve los números de renglón, en base 1, que es como los ve quien digita.
 * Una línea con débito y crédito a la vez son dos líneas mal escritas; una en
 * cero no aporta al asiento y ensucia el mayor de la cuenta.
 */
export function lineasSinUnaPata(lineas: readonly LineaCuadrable[]): number[] {
  return lineas
    .map((l, i) => {
      const d = aCentavos(l.debito);
      const c = aCentavos(l.credito);
      const unaSola = (d > 0 && c === 0) || (c > 0 && d === 0);
      return unaSola ? null : i + 1;
    })
    .filter((n): n is number => n !== null);
}

/** Ninguna pata puede ser negativa: el signo lo da la columna, no el valor. */
export function lineasConValorNegativo(
  lineas: readonly LineaCuadrable[],
): number[] {
  return lineas
    .map((l, i) => (l.debito < 0 || l.credito < 0 ? i + 1 : null))
    .filter((n): n is number => n !== null);
}

/**
 * `'CD'` + `145` → `'CD-000145'`.
 *
 * Seis dígitos con ceros a la izquierda para que ordene como texto: sin relleno,
 * `CD-1000` iría antes que `CD-999` en cualquier listado ordenado por nombre.
 */
export function armarNumero(prefijo: string, consecutivo: number): string {
  return `${prefijo}-${String(consecutivo).padStart(6, '0')}`;
}

/**
 * Cuánto suma un movimiento al saldo de la cuenta, según su naturaleza.
 *
 * Una cuenta de naturaleza débito —activo, gasto, costo— aumenta por el débito.
 * Una de naturaleza crédito —pasivo, patrimonio, ingreso— aumenta por el
 * crédito. Es lo que hace que un saldo se lea como un número solo, sin signo
 * invertido según de qué clase sea la cuenta.
 */
export function aplicarSaldo(
  naturaleza: Naturaleza,
  debito: number,
  credito: number,
): number {
  const d = aCentavos(debito);
  const c = aCentavos(credito);
  return aPesos(naturaleza === 'DEBITO' ? d - c : c - d);
}

/**
 * Los totales de la cabecera, calculados desde las líneas.
 *
 * El servicio no los recibe del cliente: los deriva. Aceptarlos permitiría
 * guardar una cabecera que dice una cosa y unas líneas que dicen otra, y el
 * trigger lo rechazaría al COMMIT con un mensaje que ya no puede señalar dónde.
 */
export function totalesDe(lineas: readonly LineaCuadrable[]): {
  totalDebito: number;
  totalCredito: number;
} {
  const { totalDebito, totalCredito } = verificarCuadre(lineas);
  return { totalDebito, totalCredito };
}
