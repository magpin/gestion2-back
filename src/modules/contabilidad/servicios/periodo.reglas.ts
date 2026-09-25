/**
 * Aritmética del calendario contable. Sin base de datos.
 *
 * Vive aparte del servicio porque es donde se equivocan los sistemas pequeños:
 * el año fiscal no siempre empieza en enero, y tratar el período como "el mes de
 * la fecha" funciona hasta que aparece la primera empresa que cierra en junio.
 */

export interface Periodo {
  anio: number;
  mes: number;
}

/**
 * En qué período contable cae una fecha.
 *
 * Con `mesCierreFiscal = 12` —lo habitual— es el calendario: enero de 2026 es
 * `2026-01`. Con otro mes, el año fiscal arranca al mes siguiente del cierre y
 * arrastra: si cierra en junio, julio de 2026 ya es del año fiscal 2027, porque
 * pertenece al ejercicio que termina en junio de 2027.
 *
 * El `mes` que devuelve es siempre el del calendario. Renumerarlo de 1 a 12
 * desde el arranque fiscal haría que el balance de "mes 1" no se pueda cotejar
 * contra ningún extracto bancario.
 */
export function periodoDeFecha(fecha: Date, mesCierreFiscal: number): Periodo {
  const mes = fecha.getMonth() + 1;
  const anio = fecha.getFullYear();

  if (mesCierreFiscal === 12) {
    return { anio, mes };
  }

  return { anio: mes > mesCierreFiscal ? anio + 1 : anio, mes };
}

/** El mes calendario anterior. Diciembre retrocede de año. */
export function mesAnterior({ anio, mes }: Periodo): Periodo {
  return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}

/** El mes calendario siguiente. */
export function mesSiguiente({ anio, mes }: Periodo): Periodo {
  return mes === 12 ? { anio: anio + 1, mes: 1 } : { anio, mes: mes + 1 };
}

/** Orden total entre períodos: negativo si `a` es anterior a `b`. */
export function compararPeriodos(a: Periodo, b: Periodo): number {
  return a.anio !== b.anio ? a.anio - b.anio : a.mes - b.mes;
}

export function mismoPeriodo(a: Periodo, b: Periodo): boolean {
  return compararPeriodos(a, b) === 0;
}

/** `2026-03`. Para mensajes de error y claves de agrupación. */
export function etiquetaPeriodo({ anio, mes }: Periodo): string {
  return `${anio}-${String(mes).padStart(2, '0')}`;
}

/**
 * Si abrir este período dejaría un hueco.
 *
 * Abrir marzo con febrero sin abrir parece inofensivo hasta el cierre: el saldo
 * inicial de marzo sale del saldo final de febrero, y si febrero nunca existió
 * ese arrastre no se puede calcular. Después, abrir febrero tarde obliga a
 * recalcular marzo entero.
 *
 * El primer período de la empresa nunca deja hueco: no hay nada antes.
 */
export function dejaHueco(
  existentes: readonly Periodo[],
  nuevo: Periodo,
): boolean {
  if (existentes.length === 0) {
    return false;
  }

  // Antes del primero no hay hueco: se está abriendo historia hacia atrás, que
  // es lo que hace falta al migrar saldos de un sistema anterior.
  const ordenados = [...existentes].sort(compararPeriodos);
  const primero = ordenados[0];
  if (compararPeriodos(nuevo, primero) < 0) {
    return false;
  }

  const anterior = mesAnterior(nuevo);
  return !existentes.some((p) => mismoPeriodo(p, anterior));
}

// ---------------------------------------------------------------------------
// Períodos automáticos
// ---------------------------------------------------------------------------

/**
 * Los meses que hay que crear para llegar al actual sin dejar huecos: desde el
 * siguiente al último que existe hasta el actual, inclusive. Sin ninguno, solo
 * el actual: es el primer período de la empresa.
 */
export function mesesACrear(
  existentes: readonly Periodo[],
  actual: Periodo,
): Periodo[] {
  if (existentes.length === 0) return [actual];
  const ultimo = [...existentes].sort(compararPeriodos).at(-1)!;
  const faltan: Periodo[] = [];
  let p = mesSiguiente(ultimo);
  while (compararPeriodos(p, actual) <= 0) {
    faltan.push(p);
    p = mesSiguiente(p);
  }
  return faltan;
}

/**
 * El primer día de un período, en fecha de calendario (AAAA-MM-DD).
 *
 * Con año fiscal distinto del calendario, el `anio` del período es el del
 * ejercicio: julio del ejercicio 2027 (cierre en junio) es julio de 2026.
 */
export function primerDiaDelPeriodo(
  { anio, mes }: Periodo,
  mesCierreFiscal: number,
): string {
  const anioCalendario =
    mesCierreFiscal !== 12 && mes > mesCierreFiscal ? anio - 1 : anio;
  return `${anioCalendario}-${String(mes).padStart(2, '0')}-01`;
}

export type Agrupacion = 'MENSUAL' | 'TRIMESTRAL' | 'SEMESTRAL' | 'ANUAL';

/**
 * A qué grupo pertenece un mes: `2026-09`, `2026-T3`, `2026-S2` o `2026`.
 * Trimestres y semestres son de calendario: enero a marzo es el primero.
 */
export function grupoDe(
  { anio, mes }: Periodo,
  agrupacion: Agrupacion,
): string {
  switch (agrupacion) {
    case 'MENSUAL':
      return etiquetaPeriodo({ anio, mes });
    case 'TRIMESTRAL':
      return `${anio}-T${Math.ceil(mes / 3)}`;
    case 'SEMESTRAL':
      return `${anio}-S${mes <= 6 ? 1 : 2}`;
    case 'ANUAL':
      return String(anio);
  }
}
