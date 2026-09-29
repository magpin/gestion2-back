/**
 * El arranque: la plata con la que una empresa empieza en el sistema, en la
 * caja y en los bancos, con su asiento de apertura (CA).
 *
 * Débito a la cuenta de cada caja y de cada banco; crédito a una sola
 * contrapartida de patrimonio, que elige quien carga (SI1, pendiente de
 * ratificar Yeris):
 * - «Lo pusieron los socios» → el capital de la empresa;
 * - «Ya venía de antes»     → utilidades acumuladas (370505).
 */

export type OrigenSaldos = 'SOCIOS' | 'ANTES';

/**
 * Las cuentas candidatas de la contrapartida, en orden: la primera que tenga
 * la empresa. El capital depende de la forma: 310505 en sociedades por
 * acciones, 311505 en limitadas, 313005 en persona natural.
 */
export const CONTRAPARTIDA: Record<OrigenSaldos, readonly string[]> = {
  SOCIOS: ['310505', '311505', '313005'],
  ANTES: ['370505'],
};

export interface SaldoACargar {
  medio: 'CAJA' | 'BANCO';
  id: string;
  /** La cuenta contable de la caja o del banco. */
  cuentaId: string;
  nombre: string;
  valor: number;
}

export interface LineaApertura {
  cuentaId: string;
  debito: number;
  credito: number;
}

/** Lo que no deja cargar, o `null`. Solo valores positivos y sin repetir. */
export function problemaDeSaldos(
  saldos: Array<{ medio: 'CAJA' | 'BANCO'; id: string; valor: number }>,
): string | null {
  if (saldos.length === 0) {
    return 'Poné al menos un valor: la caja o alguna cuenta del banco.';
  }
  if (saldos.some((s) => !(s.valor > 0))) {
    return 'Los valores tienen que ser mayores que cero.';
  }
  const vistos = new Set<string>();
  for (const s of saldos) {
    const clave = `${s.medio}:${s.id}`;
    if (vistos.has(clave)) return 'Una caja o una cuenta viene repetida.';
    vistos.add(clave);
  }
  return null;
}

/** Las líneas del asiento de apertura: un débito por caja o banco y un solo crédito. */
export function lineasDeApertura(
  saldos: SaldoACargar[],
  contrapartidaId: string,
): LineaApertura[] {
  const total = redondear(saldos.reduce((s, x) => s + x.valor, 0));
  return [
    ...saldos.map((s) => ({
      cuentaId: s.cuentaId,
      debito: s.valor,
      credito: 0,
    })),
    { cuentaId: contrapartidaId, debito: 0, credito: total },
  ];
}

export function glosaDeApertura(origen: OrigenSaldos): string {
  return origen === 'SOCIOS'
    ? 'Saldos iniciales de caja y bancos: aporte de los socios'
    : 'Saldos iniciales de caja y bancos: venían de antes';
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
