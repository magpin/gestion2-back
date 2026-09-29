/**
 * ICA y ReteICA (Fase 3 de docs/planes/plan-pantallas-complementarias.md).
 * Reglas puras: el estimado del ICA propio de un año en un municipio.
 *
 * El ICA se declara ante el municipio, no ante la DIAN, casi siempre una vez
 * al año (formulario único nacional). El estimado sale del libro:
 *
 * - base: los ingresos del año (clase 4) menos lo que no es base, como la
 *   venta de activos fijos (4245);
 * - impuesto: base × tarifa de la actividad en ese municipio, por mil;
 * - avisos y tableros: 15 % del impuesto, si la empresa tiene aviso a la
 *   vista del público (Ley 14 de 1983, art. 37);
 * - menos lo que ya se anticipó: el ReteICA que le practicaron los clientes y
 *   la autorretención (135518).
 *
 * Todo va al múltiplo de mil, como el formulario. No es la declaración: la
 * sobretasa bomberil, el anticipo del año siguiente y las exenciones de cada
 * acuerdo los pone el contador (pendiente de ratificar Yeris).
 */

/** De dónde salió la tarifa. */
export type FuenteTarifa =
  /** La ley del municipio cargada, por la actividad (CIIU) de la empresa. */
  | 'LEY'
  /** La que la empresa escribió en Configurar empresa → Impuestos. */
  | 'PROVISIONAL';

export const AVISOS_Y_TABLEROS = 0.15;

export interface IcaPropio {
  anio: number;
  /** Ingresos del año en el libro (clase 4, neta de devoluciones). */
  ingresos: number;
  /** Lo que no es base: venta de activos fijos. */
  excluidos: number;
  base: number;
  /** Por mil. `null`: sin tarifa cargada para este municipio. */
  tarifaPorMil: number | null;
  fuenteTarifa: FuenteTarifa | null;
  /** `null` sin tarifa. */
  impuesto: number | null;
  avisosTableros: boolean;
  /** 15 % del impuesto si tiene avisos; 0 si no. */
  avisos: number | null;
  /** Impuesto más avisos. */
  total: number | null;
  /** ReteICA que le practicaron y autorretención del año. */
  anticipos: number;
  /** Total menos anticipos; negativo es saldo a favor. `null` sin tarifa. */
  saldo: number | null;
}

/** Al múltiplo de mil, como el formulario único nacional. */
export const alMil = (v: number) => Math.round(v / 1000) * 1000;

export function armarIcaPropio(input: {
  anio: number;
  ingresos: number;
  excluidos: number;
  tarifaPorMil: number | null;
  fuenteTarifa: FuenteTarifa | null;
  avisosTableros: boolean;
  anticipos: number;
}): IcaPropio {
  const ingresos = alMil(input.ingresos);
  const excluidos = alMil(Math.max(0, input.excluidos));
  const base = Math.max(0, ingresos - excluidos);
  const anticipos = alMil(Math.max(0, input.anticipos));
  if (input.tarifaPorMil === null) {
    return {
      anio: input.anio,
      ingresos,
      excluidos,
      base,
      tarifaPorMil: null,
      fuenteTarifa: null,
      impuesto: null,
      avisosTableros: input.avisosTableros,
      avisos: null,
      total: null,
      anticipos,
      saldo: null,
    };
  }
  const impuesto = alMil((base * input.tarifaPorMil) / 1000);
  const avisos = input.avisosTableros ? alMil(impuesto * AVISOS_Y_TABLEROS) : 0;
  const total = impuesto + avisos;
  return {
    anio: input.anio,
    ingresos,
    excluidos,
    base,
    tarifaPorMil: input.tarifaPorMil,
    fuenteTarifa: input.fuenteTarifa,
    impuesto,
    avisosTableros: input.avisosTableros,
    avisos,
    total,
    anticipos,
    saldo: total - anticipos,
  };
}
