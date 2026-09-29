/**
 * El IVA del período (Fase 2 de las pantallas complementarias, lienzo «IVA
 * 300»). Reglas puras: de las líneas de ventas y compras al borrador del 300.
 *
 * Saldo a pagar = IVA generado − IVA descontable − IVA que le retuvieron a la
 * empresa (135517), que es un anticipo del período en que se lo practicaron.
 *
 * El sistema guarda la tarifa 0 sin separar lo exento de lo excluido (se
 * decidió así en 0025: es cosa del módulo DIAN). Las dos van en renglones
 * distintos del 300 y solo las exentas dan derecho a descontable: por eso se
 * muestran juntas con esa advertencia, y el contador las separa (E9).
 */

import { rangoDe } from './impuestos.reglas';

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface LineaIva {
  /** «2026-09». */
  mes: string;
  tarifa: number;
  /** Con signo: las notas crédito restan. */
  base: number;
  iva: number;
}

export interface LineaIvaCompra extends LineaIva {
  descontable: boolean;
}

export interface PorTarifa {
  tarifa: number;
  base: number;
  iva: number;
}

export interface IvaDelPeriodo {
  generado: { porTarifa: PorTarifa[]; total: number };
  /** Ventas a tarifa 0: exentas o excluidas, sin distinguir. */
  ventasTarifaCero: number;
  descontable: { porTarifa: PorTarifa[]; total: number };
  /** IVA pagado en compras que no se descuenta: va al costo o al gasto. */
  noDescontable: number;
  reteIvaSufrida: number;
  /** Generado − descontable − retenido. Negativo: saldo a favor. */
  saldo: number;
  mesAMes: Array<{ mes: string; generado: number; descontable: number }>;
  /** El libro (2408) contra lo que dicen los documentos. */
  cuadre: {
    libro: number;
    documentos: number;
    diferencia: number;
    cuadra: boolean;
  };
}

function porTarifa(lineas: LineaIva[]): PorTarifa[] {
  const m = new Map<number, PorTarifa>();
  for (const l of lineas) {
    if (l.tarifa === 0) continue;
    const a = m.get(l.tarifa) ?? { tarifa: l.tarifa, base: 0, iva: 0 };
    a.base += l.base;
    a.iva += l.iva;
    m.set(l.tarifa, a);
  }
  return [...m.values()]
    .map((t) => ({ tarifa: t.tarifa, base: r2(t.base), iva: r2(t.iva) }))
    .filter((t) => t.base !== 0 || t.iva !== 0)
    .sort((a, b) => b.tarifa - a.tarifa);
}

/** Los meses del período, en orden: «2026-09», «2026-10», … */
export function mesesDe(periodo: string): string[] {
  const { desde, hasta } = rangoDe(periodo);
  const meses: string[] = [];
  let [a, m] = desde.split('-').map(Number);
  const fin = hasta.slice(0, 7);
  for (;;) {
    const mes = `${a}-${String(m).padStart(2, '0')}`;
    meses.push(mes);
    if (mes >= fin) break;
    m += 1;
    if (m === 13) {
      m = 1;
      a += 1;
    }
  }
  return meses;
}

export function armarIva(input: {
  periodo: string;
  ventas: LineaIva[];
  compras: LineaIvaCompra[];
  reteIvaSufrida: number;
  /** Créditos menos débitos de la 2408 en el período, sin los pagos de declaraciones. */
  libro2408: number;
}): IvaDelPeriodo {
  const generado = porTarifa(input.ventas);
  const descontables = input.compras.filter((c) => c.descontable);
  const descontable = porTarifa(descontables);
  const totalGenerado = r2(generado.reduce((t, x) => t + x.iva, 0));
  const totalDescontable = r2(descontable.reduce((t, x) => t + x.iva, 0));
  const documentos = r2(totalGenerado - totalDescontable);
  const diferencia = r2(input.libro2408 - documentos);

  const mesAMes = mesesDe(input.periodo).map((mes) => ({
    mes,
    generado: r2(
      input.ventas.filter((v) => v.mes === mes).reduce((t, v) => t + v.iva, 0),
    ),
    descontable: r2(
      descontables.filter((c) => c.mes === mes).reduce((t, c) => t + c.iva, 0),
    ),
  }));

  return {
    generado: { porTarifa: generado, total: totalGenerado },
    ventasTarifaCero: r2(
      input.ventas
        .filter((v) => v.tarifa === 0)
        .reduce((t, v) => t + v.base, 0),
    ),
    descontable: { porTarifa: descontable, total: totalDescontable },
    noDescontable: r2(
      input.compras
        .filter((c) => !c.descontable)
        .reduce((t, c) => t + c.iva, 0),
    ),
    reteIvaSufrida: r2(input.reteIvaSufrida),
    saldo: r2(documentos - input.reteIvaSufrida),
    mesAMes,
    // Un peso de tolerancia: el libro redondea por línea y los documentos también.
    cuadre: {
      libro: r2(input.libro2408),
      documentos,
      diferencia,
      cuadra: Math.abs(diferencia) <= 1,
    },
  };
}

/** El período anterior: «2026-C3» → «2026-C2»; «2026-B1» → «2025-B6». */
export function periodoAnterior(periodo: string): string {
  const m = /^(\d{4})-([BCT])(\d)$/.exec(periodo);
  if (m === null) throw new Error(`Período de IVA inválido: ${periodo}`);
  const cuantos = { B: 6, C: 3, T: 4 }[m[2] as 'B' | 'C' | 'T'];
  const n = Number(m[3]);
  return n > 1
    ? `${m[1]}-${m[2]}${n - 1}`
    : `${Number(m[1]) - 1}-${m[2]}${cuantos}`;
}
