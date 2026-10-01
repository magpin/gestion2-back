/**
 * Gastos: reglas puras. Plan: docs/planes/plan-integracion-menu-nuevo.md,
 * Fase 6. La sugerencia viene del paquete de Claude Design
 * (`sugerir-concepto.ts`), adaptada: sin modelo, y nada se asienta solo.
 */

/**
 * Cómo de segura está María. Se dice en palabras, nunca en porcentaje:
 *   CLARA    → «la vi clara»: el mismo tercero fue a ese concepto 2 o más veces.
 *   DEDUCIDA → «la deduje»: una sola vez, o por palabras de la descripción.
 *   NO_SE    → «no sé»: nada coincide; la persona elige.
 */
export type Certeza = 'CLARA' | 'DEDUCIDA' | 'NO_SE';

export interface ConceptoConPistas {
  id: string;
  nombre: string;
  pistas: string[];
}

export interface Sugerencia {
  conceptoId: string | null;
  certeza: Certeza;
  /** Por qué, en voseo: se muestra tal cual. */
  motivo: string;
}

const normalizar = (texto: string) =>
  texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Una pista cuenta como palabra entera: «ica» no se encuentra en «publicidad». */
function contiene(texto: string, pista: string): boolean {
  const p = normalizar(pista).trim();
  if (p === '') return false;
  const escapada = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escapada}([^a-z0-9]|$)`).test(texto);
}

/**
 * El concepto que María sugiere para un gasto. Primero lo que la empresa ya
 * hizo con ese tercero; después las pistas del catálogo en la descripción.
 * La persona confirma siempre.
 */
export function sugerirConcepto(input: {
  descripcion: string;
  conceptos: ConceptoConPistas[];
  /** Conceptos que se usaron antes con este tercero, el más reciente primero. */
  historialTercero: string[];
}): Sugerencia {
  const disponibles = new Set(input.conceptos.map((c) => c.id));
  const historial = input.historialTercero.filter((id) => disponibles.has(id));
  const conteo = new Map<string, number>();
  for (const id of historial) conteo.set(id, (conteo.get(id) ?? 0) + 1);
  // A igual cantidad, el más reciente: `historial` ya viene en ese orden.
  const [masUsado] = [...conteo.entries()].sort((a, b) => b[1] - a[1]);
  const nombre = (id: string) =>
    input.conceptos.find((c) => c.id === id)?.nombre ?? 'ese concepto';

  if (masUsado && masUsado[1] >= 2) {
    return {
      conceptoId: masUsado[0],
      certeza: 'CLARA',
      motivo: `Las últimas ${masUsado[1]} veces este tercero fue a ${nombre(masUsado[0])}.`,
    };
  }

  const texto = normalizar(input.descripcion);
  const candidatos = input.conceptos
    .map((c) => ({ c, pista: c.pistas.find((p) => contiene(texto, p)) }))
    .filter(
      (x): x is { c: ConceptoConPistas; pista: string } =>
        x.pista !== undefined,
    );

  if (candidatos.length === 1) {
    const [{ c, pista }] = candidatos;
    return {
      conceptoId: c.id,
      certeza: 'DEDUCIDA',
      motivo: `Por «${pista}» en la descripción. Confírmelo usted.`,
    };
  }
  if (masUsado) {
    return {
      conceptoId: masUsado[0],
      certeza: 'DEDUCIDA',
      motivo: `La vez pasada este tercero fue a ${nombre(masUsado[0])}. Confírmelo usted.`,
    };
  }
  if (candidatos.length > 1) {
    return {
      conceptoId: null,
      certeza: 'NO_SE',
      motivo: `Puede ser ${candidatos
        .slice(0, 2)
        .map((x) => x.c.nombre)
        .join(' o ')}. Elija usted.`,
    };
  }
  return {
    conceptoId: null,
    certeza: 'NO_SE',
    motivo: 'No sé a qué concepto va. Elija usted.',
  };
}

/** El primer día del mes y el del siguiente, de «2026-09». */
export function rangoMes(mes: string): {
  desde: string;
  hasta: string;
  anterior: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (m === null) throw new Error(`Mes inválido: ${mes}`);
  const anio = Number(m[1]);
  const numero = Number(m[2]);
  const fmt = (a: number, n: number) => `${a}-${String(n).padStart(2, '0')}`;
  const siguiente = numero === 12 ? fmt(anio + 1, 1) : fmt(anio, numero + 1);
  const anterior = numero === 1 ? fmt(anio - 1, 12) : fmt(anio, numero - 1);
  return { desde: `${mes}-01`, hasta: `${siguiente}-01`, anterior };
}

/** Cuánto cambió frente al mes anterior, en porcentaje con un decimal; `null` si no hay con qué comparar. */
export function variacion(actual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return Math.round(((actual - anterior) / anterior) * 1000) / 10;
}
