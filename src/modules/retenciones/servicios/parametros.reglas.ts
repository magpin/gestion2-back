/**
 * Qué tarifa de la ley rige, a una fecha, para un beneficiario. Sin base de
 * datos: recibe la foto de parámetros ya cargada.
 *
 * Plan motor de retenciones, Fase 0 (§0.6). La tarifa se toma siempre a la
 * **fecha del documento** (R-D1), nunca a la de hoy: en 2026 la norma cambió
 * tres veces y una factura de junio se explica con la norma de junio.
 */

export interface TarifaLey {
  id: string;
  conceptoId: string;
  /** NULL = aplica a los dos tipos de persona. */
  tipoPersona: 'NATURAL' | 'JURIDICA' | null;
  /** NULL = el concepto no distingue declarantes. */
  declarante: boolean | null;
  baseUvt: number;
  /** 0.025 = 2,5 %. */
  tarifa: number;
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  norma: string;
}

export interface FotoParametros {
  /** La fecha a la que se tomó, `YYYY-MM-DD`. */
  fecha: string;
  /** La UVT del año de la fecha; `null` si no está cargada. */
  uvt: number | null;
  /** Las tarifas vigentes a la fecha, de todos los conceptos. */
  tarifas: TarifaLey[];
  /**
   * La tabla del art. 383 vigente a la fecha, en UVT (Fase 8, §8.14). Vacía
   * si no hay: entonces no se usa.
   */
  tabla383?: FilaTabla383[];
  /** Los parámetros de la ley por clave: topes de la depuración. */
  ley?: Record<string, number>;
}

/** Un tramo de la tabla de rentas de trabajo (art. 383 ET). */
export interface FilaTabla383 {
  desdeUvt: number;
  hastaUvt: number | null;
  tarifaMarginal: number;
  uvtAdicionales: number;
  norma: string;
}

/** Si una tarifa rige en una fecha (`vigencia_hasta` incluida). */
export function rigeEn(
  t: Pick<TarifaLey, 'vigenciaDesde' | 'vigenciaHasta'>,
  fecha: string,
): boolean {
  return (
    t.vigenciaDesde <= fecha &&
    (t.vigenciaHasta === null || t.vigenciaHasta >= fecha)
  );
}

/**
 * La tarifa que aplica a este beneficiario.
 *
 * Gana la fila **más específica**: la que nombra el tipo de persona le gana a
 * la que sirve para los dos, y lo mismo con declarante. Honorarios, por
 * ejemplo, tiene una fila para persona jurídica y dos para persona natural
 * (declarante y no declarante).
 *
 * Devuelve `null` si la ley no trae tarifa para esa fecha: el motor pregunta,
 * nunca calcula en cero.
 */
export function elegirTarifa(
  foto: FotoParametros,
  conceptoId: string,
  beneficiario: { tipoPersona: 'NATURAL' | 'JURIDICA'; declarante: boolean },
): TarifaLey | null {
  const candidatas = foto.tarifas.filter(
    (t) =>
      t.conceptoId === conceptoId &&
      rigeEn(t, foto.fecha) &&
      (t.tipoPersona === null || t.tipoPersona === beneficiario.tipoPersona) &&
      (t.declarante === null || t.declarante === beneficiario.declarante),
  );
  if (candidatas.length === 0) return null;
  const especificidad = (t: TarifaLey) =>
    (t.tipoPersona === null ? 0 : 2) + (t.declarante === null ? 0 : 1);
  return candidatas.reduce((mejor, t) =>
    especificidad(t) > especificidad(mejor) ? t : mejor,
  );
}
