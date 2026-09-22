/**
 * Cómo se cobra una cuenta: qué períodos se le cargan, cuánto debe y desde
 * cuándo, y cuándo el sistema la pasa a morosa o la devuelve a activa.
 *
 * Puro: las fechas llegan como `aaaa-mm-dd` en hora de Colombia, y los montos
 * en pesos enteros. Lo que decide acá se prueba sin base.
 */

/** A los cuántos días sin pagar una cuenta pasa sola a morosa. */
export const DIAS_PARA_MORA = 15;

const DIA_MS = 86_400_000;

const aFecha = (a: number, m: number, d: number): string =>
  new Date(Date.UTC(a, m - 1, d)).toISOString().slice(0, 10);

/** Días entre dos fechas `aaaa-mm-dd`: `hasta - desde`. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      DIA_MS,
  );
}

/** La fecha de corte de un período: `2026-10` con corte 5 es `2026-10-05`. */
export function corteDe(periodo: string, diaCorte: number): string {
  const [a, m] = periodo.split('-').map(Number);
  return aFecha(a, m, diaCorte);
}

const siguientePeriodo = (periodo: string): string => {
  const [a, m] = periodo.split('-').map(Number);
  return aFecha(a, m + 1, 1).slice(0, 7);
};

/**
 * Los períodos que ya hay que cobrar: cada mes cuyo corte cae entre el día
 * en que se empezó a cobrar y hoy, los dos incluidos. Si la cuenta empezó
 * después del corte de su primer mes, el primer cobro es el mes siguiente.
 */
export function periodosACobrar(
  cobroDesde: string,
  diaCorte: number,
  hoy: string,
): { periodo: string; venceEn: string }[] {
  const periodos: { periodo: string; venceEn: string }[] = [];
  let periodo = cobroDesde.slice(0, 7);
  // Tope de seguridad: más de diez años de períodos es un dato mal puesto.
  for (let i = 0; i < 130; i += 1) {
    const corte = corteDe(periodo, diaCorte);
    if (corte > hoy) break;
    if (corte >= cobroDesde) periodos.push({ periodo, venceEn: corte });
    periodo = siguientePeriodo(periodo);
  }
  return periodos;
}

/** El próximo corte después de hoy. */
export function proximoCorte(
  diaCorte: number,
  hoy: string,
  cobroDesde: string,
): string {
  let periodo = (cobroDesde > hoy ? cobroDesde : hoy).slice(0, 7);
  for (let i = 0; i < 3; i += 1) {
    const corte = corteDe(periodo, diaCorte);
    if (corte > hoy && corte >= cobroDesde) return corte;
    periodo = siguientePeriodo(periodo);
  }
  return corteDe(periodo, diaCorte);
}

export interface Cargo {
  id: string;
  periodo: string;
  plan: string;
  monto: number;
  venceEn: string;
}

export interface Pago {
  id: string;
  fecha: string;
  monto: number;
}

export type EstadoCargo = 'PAGADO' | 'PARCIAL' | 'PENDIENTE' | 'VENCIDO';

export interface CargoConEstado extends Cargo {
  pagado: number;
  estado: EstadoCargo;
}

export interface EstadoDeCuenta {
  cargos: CargoConEstado[];
  totalCargado: number;
  totalPagado: number;
  /** Lo que debe hoy, vencido o no. Negativo si pagó de más: saldo a favor. */
  saldo: number;
  /** Lo que ya venció y no se pagó. */
  vencido: number;
  /** Días desde el vencimiento más viejo sin pagar. 0 si está al día. */
  diasMora: number;
}

/**
 * Los pagos cubren los cargos del más viejo al más nuevo, sin importar a qué
 * período dijo pagar quien lo registró: es como se lee una deuda, y así un
 * pago parcial nunca deja un mes viejo colgando detrás de uno nuevo.
 */
export function estadoDeCuenta(
  cargos: Cargo[],
  pagos: Pago[],
  hoy: string,
): EstadoDeCuenta {
  const ordenados = [...cargos].sort((a, b) =>
    a.venceEn.localeCompare(b.venceEn),
  );
  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  let disponible = totalPagado;
  let vencido = 0;
  let masViejo: string | null = null;

  const conEstado = ordenados.map((c) => {
    const pagado = Math.min(c.monto, Math.max(0, disponible));
    disponible -= pagado;
    const falta = c.monto - pagado;
    let estado: EstadoCargo;
    if (falta === 0) estado = 'PAGADO';
    else if (c.venceEn < hoy) {
      estado = pagado > 0 ? 'PARCIAL' : 'VENCIDO';
      vencido += falta;
      masViejo ??= c.venceEn;
    } else estado = pagado > 0 ? 'PARCIAL' : 'PENDIENTE';
    return { ...c, pagado, estado };
  });

  const totalCargado = ordenados.reduce((s, c) => s + c.monto, 0);
  return {
    cargos: conEstado.reverse(),
    totalCargado,
    totalPagado,
    saldo: totalCargado - totalPagado,
    vencido,
    diasMora: masViejo === null ? 0 : diasEntre(masViejo, hoy),
  };
}

/**
 * Lo que el sistema hace solo con el estado de una cuenta, o `null` si no le
 * toca nada:
 *
 *  - activa con 15 días o más de mora → morosa;
 *  - morosa sin nada vencido → activa, **solo si la puso morosa el sistema**.
 *    Si la marcó una persona, la devuelve una persona: quizás hay algo más
 *    que el pago.
 *
 * Una cuenta suspendida o cancelada no se toca.
 */
export function decidirMora(
  estado: string,
  diasMora: number,
  moraPuestaPorSistema: boolean,
): 'MOROSO' | 'ACTIVO' | null {
  if (estado === 'ACTIVO' && diasMora >= DIAS_PARA_MORA) return 'MOROSO';
  if (estado === 'MOROSO' && diasMora === 0 && moraPuestaPorSistema)
    return 'ACTIVO';
  return null;
}
