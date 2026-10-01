/**
 * Impuestos (Fase 1 de docs/planes/plan-pantallas-complementarias.md). Reglas
 * puras: los períodos de cada obligación, en qué va cada declaración y cómo
 * se arma el asiento de su pago.
 *
 * Nada se transmite a la DIAN: la presentación y el pago se registran a mano
 * (PC2). Las fechas de vencimiento salen de la tabla de ley
 * `calendario_tributario`; sin fila, «por confirmar» (PC3).
 */

export type Obligacion = 'RETENCION' | 'IVA' | 'RETEICA' | 'ICA' | 'RENTA';
export type PeriodicidadIva = 'BIMESTRAL' | 'CUATRIMESTRAL';
export type Periodicidad =
  'MENSUAL' | 'BIMESTRAL' | 'CUATRIMESTRAL' | 'TRIMESTRAL' | 'ANUAL';

const r2 = (v: number) => Math.round(v * 100) / 100;

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const MESES_CORTOS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

// ─── El NIT ─────────────────────────────────────────────────────────────────

/**
 * El último dígito del NIT **sin el de verificación**: el que manda en el
 * calendario de la DIAN. `901234567` con DV 8 → 7, no 8 (E2 del plan).
 */
export function ultimoDigito(nit: string): number {
  const limpio = nit.replace(/\D/g, '');
  if (limpio === '') throw new Error('El NIT no tiene dígitos.');
  return Number(limpio[limpio.length - 1]);
}

// ─── Períodos ───────────────────────────────────────────────────────────────

/** Cuántos meses tiene cada período, y su letra en el código. */
const PASO: Record<Periodicidad, { meses: number; letra: string | null }> = {
  MENSUAL: { meses: 1, letra: null },
  BIMESTRAL: { meses: 2, letra: 'B' },
  TRIMESTRAL: { meses: 3, letra: 'T' },
  CUATRIMESTRAL: { meses: 4, letra: 'C' },
  ANUAL: { meses: 12, letra: null },
};

/** El período que contiene a `fecha` («2026-09-14»): «2026-09», «2026-B5», «2026-C3», «2026». */
export function periodoDe(periodicidad: Periodicidad, fecha: string): string {
  const anio = fecha.slice(0, 4);
  const mes = Number(fecha.slice(5, 7));
  if (periodicidad === 'MENSUAL') return fecha.slice(0, 7);
  if (periodicidad === 'ANUAL') return anio;
  const { meses, letra } = PASO[periodicidad];
  return `${anio}-${letra}${Math.ceil(mes / meses)}`;
}

/** Del código al rango de fechas. */
export function rangoDe(periodo: string): { desde: string; hasta: string } {
  const m = /^(\d{4})(?:-(\d{2}|[BCT]\d))?$/.exec(periodo);
  if (m === null) throw new Error(`Período inválido: ${periodo}`);
  const anio = Number(m[1]);
  let primerMes = 1;
  let meses = 12;
  if (m[2] !== undefined) {
    if (/^\d{2}$/.test(m[2])) {
      primerMes = Number(m[2]);
      meses = 1;
    } else {
      meses = { B: 2, T: 3, C: 4 }[m[2][0] as 'B' | 'T' | 'C'];
      primerMes = (Number(m[2].slice(1)) - 1) * meses + 1;
    }
  }
  const ultimoMes = primerMes + meses - 1;
  const ultimoDia = new Date(Date.UTC(anio, ultimoMes, 0)).getUTCDate();
  const dos = (n: number) => String(n).padStart(2, '0');
  return {
    desde: `${anio}-${dos(primerMes)}-01`,
    hasta: `${anio}-${dos(ultimoMes)}-${dos(ultimoDia)}`,
  };
}

/** Los períodos de un año, en orden. */
export function periodosDelAnio(
  periodicidad: Periodicidad,
  anio: number,
): string[] {
  const { meses } = PASO[periodicidad];
  return Array.from({ length: 12 / meses }, (_, i) =>
    periodoDe(
      periodicidad,
      `${anio}-${String(i * meses + 1).padStart(2, '0')}-01`,
    ),
  );
}

/** «septiembre», «sep–dic», «2025». */
export function nombrePeriodo(periodo: string): string {
  const { desde, hasta } = rangoDe(periodo);
  const a = Number(desde.slice(5, 7)) - 1;
  const b = Number(hasta.slice(5, 7)) - 1;
  if (a === 0 && b === 11) return desde.slice(0, 4);
  if (a === b) return MESES[a];
  return `${MESES_CORTOS[a]}–${MESES_CORTOS[b]}`;
}

export const NOMBRE_OBLIGACION: Record<Obligacion, string> = {
  RETENCION: 'Retención en la fuente',
  IVA: 'IVA',
  RETEICA: 'ReteICA',
  ICA: 'ICA',
  RENTA: 'Renta',
};

export const FORMULARIO: Record<Obligacion, string | null> = {
  RETENCION: '350',
  IVA: '300',
  RETEICA: null,
  ICA: null,
  RENTA: '110',
};

/**
 * Las cuentas del pasivo que paga cada declaración. El pago las debita por lo
 * que se causó en el período.
 */
export const CUENTAS_DE: Record<Obligacion, string[]> = {
  RETENCION: ['2365', '2367'],
  // El IVA que le retuvieron a la empresa (135517) se descuenta del que se paga.
  IVA: ['2408', '135517'],
  RETEICA: ['2368'],
  // El ReteICA que le practicaron a la empresa y su autorretención (135518)
  // son anticipos del ICA del año: se descuentan del que se paga.
  ICA: ['2412', '135518'],
  RENTA: ['2404'],
};

// ─── En qué va ──────────────────────────────────────────────────────────────

export type EstadoObligacion =
  /** El período no ha terminado: se sigue causando. */
  | 'CAUSANDOSE'
  /** Terminó y no se ha registrado la presentación. */
  | 'POR_PRESENTAR'
  | 'PRESENTADA'
  | 'PAGADA';

export interface Situacion {
  estado: EstadoObligacion;
  /** Días que faltan para el vencimiento (negativo si ya pasó); `null` sin fecha. */
  dias: number | null;
  /** Venció y no se ha pagado. */
  vencida: boolean;
}

const DIA = 86_400_000;
const ms = (f: string) => Date.parse(`${f}T00:00:00Z`);

export function situacion(input: {
  periodo: string;
  hoy: string;
  vence: string | null;
  declaracion: { estado: 'PRESENTADA' | 'PAGADA' } | null;
}): Situacion {
  const { hasta } = rangoDe(input.periodo);
  const estado: EstadoObligacion =
    input.declaracion !== null
      ? input.declaracion.estado
      : hasta >= input.hoy
        ? 'CAUSANDOSE'
        : 'POR_PRESENTAR';
  const dias =
    input.vence === null
      ? null
      : Math.round((ms(input.vence) - ms(input.hoy)) / DIA);
  return {
    estado,
    dias,
    vencida: estado !== 'PAGADA' && dias !== null && dias < 0,
  };
}

// ─── El pago ────────────────────────────────────────────────────────────────

export interface SaldoCausado {
  cuentaId: string;
  codigo: string;
  nombre: string;
  /**
   * A quién se le practicó: la 2365 y la 2367 van por tercero, y el pago las
   * salda tercero por tercero para que su auxiliar quede en cero.
   */
  terceroId: string | null;
  /** La cuenta pide base gravable: el pago la lleva en cero, para no sumar dos veces en la exógena. */
  exigeBase: boolean;
  /** Créditos menos débitos del período: lo que se debe por esa cuenta. */
  valor: number;
}

export interface PartidaPago {
  cuentaId: string;
  codigo: string;
  nombre: string;
  terceroId: string | null;
  exigeBase: boolean;
  debito: number;
  credito: number;
}

/**
 * Hasta cuánto se atribuye al redondeo la diferencia entre lo que dice el
 * formulario y lo causado en el libro. El formulario va al múltiplo de mil
 * por renglón (art. 577 ET): con una decena de renglones no pasa de 5.000.
 * Más que eso no es redondeo: es un libro que no cuadra con la declaración.
 */
export const TOLERANCIA_REDONDEO = 5_000;

export type ArmadoPago =
  | {
      ok: true;
      partidas: PartidaPago[];
      /** Formulario menos libro: lo que va a «ajuste al peso». */
      redondeo: number;
      /** Lo que sale de la caja o el banco (sin el 4×1000, que va aparte). */
      total: number;
    }
  | { ok: false; motivo: string };

/**
 * El asiento del pago: se debita cada cuenta por lo que se causó, los
 * intereses a su cuenta, y la diferencia del redondeo al mil a «ajuste al
 * peso» (ingreso si se pagó menos, gasto si se pagó más). Una cuenta con
 * saldo a favor (negativo) resta.
 */
export function armarPago(input: {
  causado: SaldoCausado[];
  valorAPagar: number;
  intereses: number;
  cuentaIntereses: { cuentaId: string; codigo: string; nombre: string } | null;
  ajusteIngreso: { cuentaId: string; codigo: string; nombre: string };
  ajusteGasto: { cuentaId: string; codigo: string; nombre: string };
}): ArmadoPago {
  const causado = input.causado.filter((c) => r2(c.valor) !== 0);
  const exacto = r2(causado.reduce((t, c) => t + c.valor, 0));
  if (exacto <= 0) {
    return {
      ok: false,
      motivo:
        'En el libro no hay nada causado para este período: no hay qué pagar. Revise el período o los asientos.',
    };
  }
  const redondeo = r2(input.valorAPagar - exacto);
  if (Math.abs(redondeo) > TOLERANCIA_REDONDEO) {
    return {
      ok: false,
      motivo: `La declaración dice ${pesos(input.valorAPagar)} y en el libro se causaron ${pesos(exacto)}: la diferencia (${pesos(redondeo)}) es más que el redondeo al mil. Corrija el valor de la presentación o revise el libro antes de pagar.`,
    };
  }
  if (input.intereses > 0 && input.cuentaIntereses === null) {
    return { ok: false, motivo: 'Falta la cuenta de los intereses de mora.' };
  }
  const partidas: PartidaPago[] = causado.map((c) => ({
    cuentaId: c.cuentaId,
    codigo: c.codigo,
    nombre: c.nombre,
    terceroId: c.terceroId,
    exigeBase: c.exigeBase,
    debito: c.valor > 0 ? r2(c.valor) : 0,
    credito: c.valor < 0 ? r2(-c.valor) : 0,
  }));
  if (input.intereses > 0 && input.cuentaIntereses !== null) {
    partidas.push({
      ...input.cuentaIntereses,
      terceroId: null,
      exigeBase: false,
      debito: r2(input.intereses),
      credito: 0,
    });
  }
  if (redondeo > 0)
    partidas.push({
      ...input.ajusteGasto,
      terceroId: null,
      exigeBase: false,
      debito: redondeo,
      credito: 0,
    });
  if (redondeo < 0)
    partidas.push({
      ...input.ajusteIngreso,
      terceroId: null,
      exigeBase: false,
      debito: 0,
      credito: -redondeo,
    });
  return {
    ok: true,
    partidas,
    redondeo,
    total: r2(input.valorAPagar + input.intereses),
  };
}

function pesos(v: number): string {
  return `$ ${Math.round(v).toLocaleString('es-CO')}`;
}

/** «el miércoles 21 oct». */
export function fechaEnPalabras(fecha: string): string {
  const d = new Date(ms(fecha));
  const dias = [
    'domingo',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
  ];
  return `el ${dias[d.getUTCDay()]} ${d.getUTCDate()} ${MESES_CORTOS[d.getUTCMonth()]}`;
}
