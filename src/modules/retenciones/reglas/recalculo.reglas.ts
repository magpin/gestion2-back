/**
 * El recálculo por cambio de norma, sin base de datos (plan motor de
 * retenciones, Fase 6, §6.3).
 *
 * Entra lo que una compra tiene vivo hoy —lo registrado, menos lo que
 * devolvieron sus notas, más los ajustes— y lo que el motor calcula con la
 * misma entrada y la norma nueva. Sale lo que cambió, por retención. No decide
 * nada más: ajustar lo decide una persona (R-D6).
 */

/** Una retención viva de la compra, ya sumada por clave. */
export interface RetencionVivaClave {
  /** La original: la que corrige el ajuste. */
  retencionId: string;
  impuesto: 'RENTA' | 'IVA' | 'ICA';
  conceptoCodigo: string;
  conceptoId: string;
  municipio: string | null;
  base: number;
  valor: number;
  /** Como fracción: 0.025. */
  tarifa: number;
}

/** Lo que el motor calcula hoy con la misma entrada, para el documento entero. */
export interface RetencionNueva {
  impuesto: 'RENTA' | 'IVA' | 'ICA';
  conceptoCodigo: string;
  conceptoId: string;
  municipio: string | null;
  nombre: string;
  base: number;
  valor: number;
  /** Como fracción: 0.025. */
  tarifa: number;
  /** La frase del motor: por qué retiene esto. */
  texto: string;
}

export interface Diferencia {
  impuesto: 'RENTA' | 'IVA' | 'ICA';
  conceptoId: string;
  conceptoCodigo: string;
  municipio: string | null;
  retencionId: string | null;
  /** La base con la norma nueva, llevada a lo vivo. */
  base: number;
  /** La base viva de lo registrado: el ajuste lleva la diferencia de bases. */
  baseAntes: number;
  antes: number;
  nuevo: number;
  diferencia: number;
  tarifaAntes: number | null;
  tarifaNueva: number | null;
  texto: string;
}

export const claveDe = (r: {
  impuesto: string;
  conceptoCodigo: string;
  municipio: string | null;
}): string => `${r.impuesto}|${r.conceptoCodigo}|${r.municipio ?? ''}`;

const pesos = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const pct = (f: number) =>
  `${(f * 100).toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`;

/**
 * Lo que cambia en una compra, o en la autorretención de una venta.
 *
 * `fraccionViva` es lo que queda de la compra después de sus notas crédito
 * (1 si no tuvo): lo nuevo se calcula sobre el documento entero, como lo hace
 * el motor, y se lleva a lo que sigue vivo, igual que las notas bajaron lo
 * registrado.
 *
 * Una retención que antes no existía (la base mínima bajó) sale con
 * `retencionId` nulo; una que ya no corresponde (la base subió) sale con
 * `nuevo` en cero. Menos de un peso de diferencia no es diferencia.
 */
export function compararRecalculo(
  vivas: RetencionVivaClave[],
  nuevas: RetencionNueva[],
  fraccionViva: number,
  documento: 'compra' | 'venta' = 'compra',
): Diferencia[] {
  const retener = documento === 'venta' ? 'autorretenía' : 'retenía';
  const retenidos = documento === 'venta' ? 'autorretuvieron' : 'retuvieron';
  const antes = new Map(vivas.map((v) => [claveDe(v), v]));
  const despues = new Map(nuevas.map((n) => [claveDe(n), n]));
  const claves = [...new Set([...antes.keys(), ...despues.keys()])].sort();

  const diferencias: Diferencia[] = [];
  for (const clave of claves) {
    const a = antes.get(clave);
    const n = despues.get(clave);
    const valorAntes = Math.round(a?.valor ?? 0);
    const valorNuevo = Math.round((n?.valor ?? 0) * fraccionViva);
    const diferencia = valorNuevo - valorAntes;
    if (diferencia === 0) continue;

    const nombre = n?.nombre ?? a?.conceptoCodigo.replace(/_/g, ' ') ?? clave;
    const tarifas =
      a !== undefined && n !== undefined && a.tarifa !== n.tarifa
        ? ` (tarifa ${pct(a.tarifa)} → ${pct(n.tarifa)})`
        : '';
    const texto =
      a === undefined
        ? `Con la norma vigente, esta ${documento} lleva ${nombre.toLowerCase()} de ${pesos(valorNuevo)}, que antes no se ${retener}. ${n?.texto ?? ''}`.trim()
        : n === undefined
          ? `Con la norma vigente, esta ${documento} ya no lleva ${nombre.toLowerCase()}: se ${retenidos} ${pesos(valorAntes)} de más.`
          : `Con la norma vigente, ${nombre.toLowerCase()} pasa de ${pesos(valorAntes)} a ${pesos(valorNuevo)}${tarifas}.`;

    diferencias.push({
      impuesto: (n ?? a)!.impuesto,
      conceptoId: (n ?? a)!.conceptoId,
      conceptoCodigo: (n ?? a)!.conceptoCodigo,
      municipio: (n ?? a)!.municipio,
      retencionId: a?.retencionId ?? null,
      base: n !== undefined ? Math.round(n.base * fraccionViva * 100) / 100 : 0,
      baseAntes: a?.base ?? 0,
      antes: valorAntes,
      nuevo: valorNuevo,
      diferencia,
      tarifaAntes: a?.tarifa ?? null,
      tarifaNueva: n?.tarifa ?? null,
      texto,
    });
  }
  return diferencias;
}
