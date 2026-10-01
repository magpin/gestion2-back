/**
 * Centros de costo en memoria. Sin base de datos.
 *
 * Un centro dice DÓNDE se vendió o se gastó (sede, área, proyecto); la cuenta
 * del PUC sigue diciendo EN QUÉ. Ver `docs/planes/plan-centros-de-costo.md`.
 */

/**
 * De dónde sale el centro de un renglón, en orden (D3): lo que se eligió en el
 * renglón, lo de la cabecera del documento, el del usuario, el de la sede de
 * la caja y, al final, el de por defecto de la empresa. Gana el primero que
 * haya.
 */
export interface CandidatosCentro {
  renglon?: string | null;
  cabecera?: string | null;
  usuario?: string | null;
  sedeCaja?: string | null;
  porDefecto?: string | null;
}

export function resolverCentro(c: CandidatosCentro): string | null {
  return (
    c.renglon || c.cabecera || c.usuario || c.sedeCaja || c.porDefecto || null
  );
}

/** Lo mínimo de una línea de asiento para completarle el centro. */
export interface LineaConCentro {
  cuentaId: string;
  centroCostoId?: string | null;
}

/**
 * La red de los asientos automáticos: la línea cuya cuenta exige centro y no
 * lo trae va al de por defecto de la empresa. Así encender los centros no
 * rompe un flujo que todavía no sabe elegir el suyo; ese movimiento queda en
 * el centro por defecto y no en un error.
 *
 * Sin centro por defecto no se completa nada: el trigger de la base dirá qué
 * cuenta lo exige.
 */
export function completarCentros<L extends LineaConCentro>(
  lineas: L[],
  cuentasQueExigen: ReadonlySet<string>,
  porDefecto: string | null,
): L[] {
  if (porDefecto === null) return lineas;
  return lineas.map((l) =>
    !l.centroCostoId && cuentasQueExigen.has(l.cuentaId)
      ? { ...l, centroCostoId: porDefecto }
      : l,
  );
}

/** Una parte de un reparto: a qué centro y qué porcentaje. */
export interface ParteReparto {
  centroCostoId: string;
  porcentaje: number;
}

/** Si las partes suman 100 %. Con cuatro decimales de holgura: 33,3333 × 3. */
export function repartoCompleto(partes: ParteReparto[]): boolean {
  const suma = partes.reduce((s, p) => s + p.porcentaje, 0);
  return partes.length > 0 && Math.abs(suma - 100) < 0.001;
}

/**
 * Parte un valor por porcentajes, en centavos. Cada parte se redondea y la
 * última se lleva lo que falte: así las partes suman exacto el valor, que es
 * lo que el asiento necesita para cuadrar.
 */
export function repartirValor(
  valor: number,
  partes: ParteReparto[],
): Array<{ centroCostoId: string; valor: number }> {
  if (!repartoCompleto(partes)) {
    throw new Error('Los porcentajes del reparto tienen que sumar 100 %.');
  }
  const centavos = Math.round(valor * 100);
  let asignado = 0;
  return partes.map((p, i) => {
    const parte =
      i === partes.length - 1
        ? centavos - asignado
        : Math.round((centavos * p.porcentaje) / 100);
    asignado += parte;
    return { centroCostoId: p.centroCostoId, valor: parte / 100 };
  });
}

/** Lo mínimo de una línea de asiento para repartirla. */
export interface LineaRepartible extends LineaConCentro {
  repartoId?: string | null;
  debito?: number;
  credito?: number;
}

/**
 * Las líneas con reparto, partidas en una por centro (D6). Las demás quedan
 * igual. Una parte que da cero no se agrega: el asiento no lleva líneas en
 * cero.
 */
export function expandirRepartos<L extends LineaRepartible>(
  lineas: L[],
  repartos: ReadonlyMap<string, ParteReparto[]>,
): L[] {
  return lineas.flatMap((l) => {
    if (!l.repartoId) return [l];
    const partes = repartos.get(l.repartoId);
    if (partes === undefined) {
      throw new Error('El reparto de una línea no existe o está inactivo.');
    }
    const debito = l.debito ?? 0;
    const credito = l.credito ?? 0;
    const lado = debito > 0 ? 'debito' : 'credito';
    return repartirValor(lado === 'debito' ? debito : credito, partes)
      .filter((p) => p.valor !== 0)
      .map((p) => ({
        ...l,
        repartoId: undefined,
        centroCostoId: p.centroCostoId,
        debito: lado === 'debito' ? p.valor : 0,
        credito: lado === 'credito' ? p.valor : 0,
      }));
  });
}
