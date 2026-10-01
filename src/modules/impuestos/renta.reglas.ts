/**
 * Renta (Fase 4 de docs/planes/plan-pantallas-complementarias.md). Reglas
 * puras: el estimado del impuesto de renta de una sociedad y sus cuotas.
 *
 * Es un **estimado desde el libro, no la declaración** (Y8, pendiente de
 * ratificar Yeris):
 *
 * - renta líquida: la utilidad contable del año (sin el gasto de renta) más lo
 *   que no se puede restar: la mitad del 4×1000 (art. 115 ET), las multas y
 *   sanciones y los intereses de mora de impuestos (art. 105 ET);
 * - impuesto: renta líquida por la tarifa general (art. 240 ET), o la parte
 *   de ella que paga una sociedad ZOMAC (Ley 1819 de 2016, art. 237);
 * - menos las retenciones y autorretenciones del año (135515) y el anticipo
 *   que se liquidó el año pasado; más el anticipo del año siguiente (art. 807);
 * - las cuotas pagan el **saldo a pagar**, no el impuesto (E8).
 *
 * Todo al múltiplo de mil (art. 577 ET). No incluye la tasa mínima de
 * tributación, los descuentos tributarios, las rentas exentas ni la
 * depreciación fiscal: eso lo pone el contador.
 */

export const TARIFA_GENERAL = 0.35;
/** La parte del 4×1000 que sí se puede restar (art. 115 ET). */
export const GMF_DEDUCIBLE = 0.5;

/** Al múltiplo de mil, como el formulario. */
export const alMil = (v: number) => Math.round(v / 1000) * 1000;

/**
 * El porcentaje del anticipo (art. 807 ET): 25 % el primer año que se
 * declara, 50 % el segundo y 75 % de ahí en adelante. Sin saber desde cuándo,
 * 75 %.
 */
export function porcentajeAnticipo(anioDeclaracion: number | null): number {
  if (anioDeclaracion === null || anioDeclaracion >= 3) return 0.75;
  return anioDeclaracion === 2 ? 0.5 : 0.25;
}

export interface Anticipo {
  porcentaje: number;
  /** Impuesto del año × porcentaje − retenciones. */
  procedimiento1: number;
  /** Promedio de los dos últimos años × porcentaje − retenciones; `null` sin el año anterior. */
  procedimiento2: number | null;
  /** El menor de los dos, sin bajar de cero: el contribuyente elige. */
  valor: number;
}

export function calcularAnticipo(input: {
  impuestoNeto: number;
  impuestoNetoAnterior: number | null;
  retenciones: number;
  anioDeclaracion: number | null;
}): Anticipo {
  const porcentaje = porcentajeAnticipo(input.anioDeclaracion);
  const procedimiento1 = alMil(
    input.impuestoNeto * porcentaje - input.retenciones,
  );
  // El promedio no aplica el primer año: no hay año anterior.
  const procedimiento2 =
    input.impuestoNetoAnterior === null || input.anioDeclaracion === 1
      ? null
      : alMil(
          ((input.impuestoNeto + input.impuestoNetoAnterior) / 2) * porcentaje -
            input.retenciones,
        );
  const menor =
    procedimiento2 === null
      ? procedimiento1
      : Math.min(procedimiento1, procedimiento2);
  return {
    porcentaje,
    procedimiento1,
    procedimiento2,
    valor: Math.max(0, menor),
  };
}

export interface Cuota {
  numero: number;
  valor: number;
}

/** El saldo a pagar en cuotas parejas, al mil; la última se lleva lo que sobra. */
export function cuotasDe(saldo: number, cuantas: number): Cuota[] {
  if (saldo <= 0) return [];
  const pareja = alMil(saldo / cuantas);
  return Array.from({ length: cuantas }, (_, i) => ({
    numero: i + 1,
    valor: i === cuantas - 1 ? saldo - pareja * (cuantas - 1) : pareja,
  }));
}

export interface RentaEstimada {
  anio: number;
  utilidad: number;
  /** La mitad del 4×1000 del año. */
  gmfNoDeducible: number;
  /** Multas, sanciones e intereses de mora. */
  multas: number;
  /** No baja de cero: una pérdida no paga impuesto. */
  rentaLiquida: number;
  tarifa: number;
  /** El factor ZOMAC del año; 1 si no es ZOMAC. */
  factorZomac: number;
  impuesto: number;
  retenciones: number;
  /** El que se liquidó en la declaración del año anterior; `null` si no está registrada. */
  anticipoAnterior: number | null;
  anticipoSiguiente: Anticipo;
  /** Negativo: saldo a favor. */
  saldo: number;
  cuotas: Cuota[];
}

export function estimarRenta(input: {
  anio: number;
  utilidad: number;
  gmf: number;
  multas: number;
  factorZomac: number;
  retenciones: number;
  anticipoAnterior: number | null;
  impuestoNetoAnterior: number | null;
  anioDeclaracion: number | null;
  cuotas: number;
}): RentaEstimada {
  const utilidad = alMil(input.utilidad);
  const gmfNoDeducible = alMil(Math.max(0, input.gmf) * (1 - GMF_DEDUCIBLE));
  const multas = alMil(Math.max(0, input.multas));
  const rentaLiquida = Math.max(0, utilidad + gmfNoDeducible + multas);
  const tarifa = TARIFA_GENERAL * input.factorZomac;
  const impuesto = alMil(rentaLiquida * tarifa);
  const retenciones = alMil(Math.max(0, input.retenciones));
  const anticipoSiguiente = calcularAnticipo({
    impuestoNeto: impuesto,
    impuestoNetoAnterior: input.impuestoNetoAnterior,
    retenciones,
    anioDeclaracion: input.anioDeclaracion,
  });
  const anticipoAnterior =
    input.anticipoAnterior === null ? null : alMil(input.anticipoAnterior);
  const saldo =
    impuesto + anticipoSiguiente.valor - retenciones - (anticipoAnterior ?? 0);
  return {
    anio: input.anio,
    utilidad,
    gmfNoDeducible,
    multas,
    rentaLiquida,
    tarifa,
    factorZomac: input.factorZomac,
    impuesto,
    retenciones,
    anticipoAnterior,
    anticipoSiguiente,
    saldo,
    cuotas: cuotasDe(saldo, input.cuotas),
  };
}

export type ArmadoCuota =
  | {
      ok: true;
      partidas: Array<{
        cuentaId: string;
        codigo: string;
        nombre: string;
        debito: number;
      }>;
      total: number;
    }
  | { ok: false; motivo: string };

/**
 * El asiento de una cuota: debita la 2404 por el valor de la cuota (de las
 * subcuentas con saldo, la de más saldo primero) y los intereses a su cuenta.
 * La 2404 tiene que alcanzar: si no, el impuesto no está causado o las
 * retenciones no se han cruzado, y eso lo arregla el contador antes.
 */
export function armarCuota(input: {
  valor: number;
  intereses: number;
  saldos2404: Array<{
    cuentaId: string;
    codigo: string;
    nombre: string;
    saldo: number;
  }>;
  cuentaIntereses: { cuentaId: string; codigo: string; nombre: string } | null;
}): ArmadoCuota {
  const conSaldo = input.saldos2404
    .filter((s) => s.saldo > 0)
    .sort((a, b) => b.saldo - a.saldo);
  const disponible = conSaldo.reduce((t, s) => t + s.saldo, 0);
  if (disponible + 0.005 < input.valor) {
    return {
      ok: false,
      motivo:
        disponible <= 0
          ? 'La renta no está causada en el libro (2404). Cáusela primero (5405 contra 2404) y cruce las retenciones y el anticipo; después registre el pago.'
          : `En la 2404 quedan $ ${Math.round(disponible).toLocaleString('es-CO')} y la cuota es de $ ${Math.round(input.valor).toLocaleString('es-CO')}. Revise que la renta esté causada completa antes de pagar.`,
    };
  }
  if (input.intereses > 0 && input.cuentaIntereses === null) {
    return { ok: false, motivo: 'Falta la cuenta de los intereses de mora.' };
  }
  const partidas: Array<{
    cuentaId: string;
    codigo: string;
    nombre: string;
    debito: number;
  }> = [];
  let falta = input.valor;
  for (const s of conSaldo) {
    if (falta <= 0) break;
    const toma = Math.min(s.saldo, falta);
    partidas.push({
      cuentaId: s.cuentaId,
      codigo: s.codigo,
      nombre: s.nombre,
      debito: Math.round(toma * 100) / 100,
    });
    falta -= toma;
  }
  if (input.intereses > 0 && input.cuentaIntereses !== null) {
    partidas.push({ ...input.cuentaIntereses, debito: input.intereses });
  }
  return { ok: true, partidas, total: input.valor + input.intereses };
}
