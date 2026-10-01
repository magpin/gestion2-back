import {
  resolverCuentaConcepto,
  type DefinicionConcepto,
} from '../../../common/contabilidad/cuentas-automaticas';

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
        'Ya hay un arqueo abierto para esta caja. Ciérrelo antes de abrir uno nuevo.',
    };
  }
  return { ok: true };
}

/**
 * Los billetes y monedas de peso colombiano en circulación. Viven en el código
 * y no en la base: cambian cuando el Banco de la República emite o retira una
 * denominación —pocas veces en una década—, y ese día es un cambio revisado,
 * no un dato que alguien digite.
 *
 * El 1.000 está en los dos lados: existen el billete y la moneda.
 */
export const DENOMINACIONES_COP = {
  BILLETE: [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000],
  MONEDA: [1_000, 500, 200, 100, 50],
} as const;

export type TipoDenominacion = keyof typeof DENOMINACIONES_COP;

export interface ConteoDenominacion {
  tipo: TipoDenominacion;
  denominacion: number;
  cantidad: number;
}

/**
 * Lo que se contó en un arqueo: el total, y las denominaciones que se guardan.
 *
 * Se puede cerrar con el total a secas —como hasta ahora— o con el conteo
 * billete por billete. Con las dos cosas, tienen que coincidir: si alguien
 * contó 480.000 en billetes y escribió 500.000, uno de los dos números está
 * mal y el sistema no puede saber cuál.
 *
 * Las cantidades en cero se descartan en vez de rechazarse: la pantalla
 * muestra todas las denominaciones y la mayoría quedan en cero.
 */
export type ResultadoConteo =
  | { ok: true; saldoContado: number; denominaciones: ConteoDenominacion[] }
  | { ok: false; motivo: string };

export function resolverConteo(
  saldoContado: number | undefined,
  denominaciones: readonly ConteoDenominacion[] | undefined,
): ResultadoConteo {
  if (denominaciones === undefined) {
    if (saldoContado === undefined) {
      return {
        ok: false,
        motivo: 'Falta lo contado: el total, o billete por billete.',
      };
    }
    return { ok: true, saldoContado, denominaciones: [] };
  }

  const vistas = new Set<string>();
  const contadas: ConteoDenominacion[] = [];
  let totalCentavos = 0;
  for (const d of denominaciones) {
    const validas: readonly number[] = DENOMINACIONES_COP[d.tipo] ?? [];
    if (!validas.includes(d.denominacion)) {
      return {
        ok: false,
        motivo: `No existe ${d.tipo === 'BILLETE' ? 'el billete' : 'la moneda'} de ${d.denominacion}.`,
      };
    }
    if (!Number.isInteger(d.cantidad) || d.cantidad < 0) {
      return {
        ok: false,
        motivo: `La cantidad de ${d.tipo === 'BILLETE' ? 'billetes' : 'monedas'} de ${d.denominacion} tiene que ser un entero, cero o más.`,
      };
    }
    const clave = `${d.tipo}-${d.denominacion}`;
    if (vistas.has(clave)) {
      return {
        ok: false,
        motivo: `${d.tipo === 'BILLETE' ? 'El billete' : 'La moneda'} de ${d.denominacion} aparece dos veces.`,
      };
    }
    vistas.add(clave);
    if (d.cantidad > 0) {
      contadas.push(d);
      totalCentavos += Math.round(d.denominacion * 100) * d.cantidad;
    }
  }

  const total = totalCentavos / 100;
  if (saldoContado !== undefined && redondear(saldoContado) !== total) {
    return {
      ok: false,
      motivo: `El conteo suma ${total} y el total digitado es ${saldoContado}: uno de los dos está mal.`,
    };
  }
  return { ok: true, saldoContado: total, denominaciones: contadas };
}

// ---------------------------------------------------------------------------
// Las cuentas de un arqueo con diferencia
// ---------------------------------------------------------------------------

/**
 * Una diferencia de arqueo no es una sola cosa. Plata de más es un ingreso sin
 * explicar; plata de menos o la paga quien respondía por la caja —y es una
 * cuenta por cobrar a esa persona— o la asume la empresa como gasto.
 */
export type ConceptoArqueo =
  'SOBRANTE' | 'FALTANTE_COBRABLE' | 'FALTANTE_ASUMIDO';

export type TratamientoFaltante = 'EMPRESA' | 'RESPONSABLE';

export const CONCEPTOS_ARQUEO: Record<ConceptoArqueo, DefinicionConcepto> = {
  SOBRANTE: {
    familia: '429553',
    codigoCrear: '429553',
    nombreCuenta: 'Sobrantes de caja',
    etiqueta: 'Sobrante de caja',
    explicacion:
      'Dinero de más al contar la caja: un ingreso que no se registró.',
    columna: 'cuenta_sobrante_id',
  },
  FALTANTE_COBRABLE: {
    familia: '136530',
    codigoCrear: '136530',
    nombreCuenta: 'Faltantes de caja por cobrar',
    etiqueta: 'Faltante de caja cobrable al responsable',
    explicacion:
      'Dinero de menos que paga quien respondía por la caja: queda como cuenta por cobrar a esa persona.',
    exigeTercero: true,
    columna: 'cuenta_faltante_cobrable_id',
  },
  FALTANTE_ASUMIDO: {
    familia: '531595',
    codigoCrear: '531595',
    nombreCuenta: 'Faltantes de caja asumidos',
    etiqueta: 'Faltante de caja asumido por la empresa',
    explicacion: 'Dinero de menos que la empresa asume como gasto.',
    columna: 'cuenta_faltante_asumido_id',
  },
};

export const ORDEN_CONCEPTOS: ConceptoArqueo[] = [
  'SOBRANTE',
  'FALTANTE_COBRABLE',
  'FALTANTE_ASUMIDO',
];

// La regla de auxiliares es la de todas las cuentas automáticas: vive en
// `common/contabilidad`. Se reexporta porque es parte de las reglas de caja.
export { resolverCuentaConcepto };

export type CuentaDeAjuste =
  { ok: true; concepto: ConceptoArqueo } | { ok: false; motivo: string };

/**
 * Qué concepto lleva el ajuste de un arqueo. El sobrante no pregunta; el
 * faltante sí, porque qué pasó con la plata lo sabe quien cerró la caja, no
 * el sistema.
 */
export function conceptoDelAjuste(
  diferencia: number,
  tratamiento: TratamientoFaltante | undefined,
): CuentaDeAjuste {
  if (diferencia > 0) {
    return { ok: true, concepto: 'SOBRANTE' };
  }
  if (tratamiento === undefined) {
    return {
      ok: false,
      motivo:
        'Hay un faltante: indique si lo asume la empresa o lo paga el responsable de la caja.',
    };
  }
  return {
    ok: true,
    concepto:
      tratamiento === 'RESPONSABLE' ? 'FALTANTE_COBRABLE' : 'FALTANTE_ASUMIDO',
  };
}

/**
 * Qué impide que una caja lleve esta cuenta, o `null`. Tiene que estar
 * activa, recibir asientos y colgar de 1105; la caja menor, de 110510. Sin
 * esto, una caja podía quedar sobre una cuenta que agrupa y fallar recién al
 * primer movimiento.
 */
export function problemaCuentaDeCaja(
  tipo: 'PRINCIPAL' | 'MENOR',
  cuenta: { codigo: string; activa: boolean; esAuxiliar: boolean },
): string | null {
  if (!cuenta.activa)
    return `La cuenta ${cuenta.codigo} está inactiva. Actívela en Plan de cuentas.`;
  if (!cuenta.esAuxiliar)
    return `La cuenta ${cuenta.codigo} agrupa otras y no recibe asientos: elija uno de sus auxiliares o cree uno.`;
  const prefijo = tipo === 'MENOR' ? '110510' : '1105';
  if (!cuenta.codigo.startsWith(prefijo))
    return tipo === 'MENOR'
      ? `La caja menor va en una cuenta de 110510 (caja menor); la ${cuenta.codigo} no lo es.`
      : `Una caja va en una cuenta de 1105 (caja); la ${cuenta.codigo} no lo es.`;
  return null;
}
