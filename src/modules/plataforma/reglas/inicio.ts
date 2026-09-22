/**
 * Lo que decide qué sale en «Para atender hoy» y cómo se leen las cifras del
 * mes. Puro: las fechas llegan como `aaaa-mm-dd` en hora de Colombia.
 */

/** Cuántos días de mora hacen un pendiente. */
export const DIAS_MORA_AVISO = 15;
/** Cuántas veces su promedio tiene que gastar una empresa para avisar. */
export const VECES_IA_DISPARADA = 3;
/** Por debajo de este promedio mensual, en US$, una subida no dice nada. */
export const PROMEDIO_IA_MINIMO = 0.5;
/** Una cuenta nueva que lleva entre 7 y 30 días sin terminar la configuración. */
export const DIAS_CUENTA_NUEVA = { desde: 7, hasta: 30 } as const;

/** El primer día del mes de una fecha. */
export const inicioDeMes = (dia: string): string => `${dia.slice(0, 7)}-01`;

/** El mes anterior, completo. */
export function mesAnterior(dia: string): { desde: string; hasta: string } {
  const [a, m] = dia.split('-').map(Number);
  const desde = new Date(Date.UTC(a, m - 2, 1));
  const hasta = new Date(Date.UTC(a, m - 1, 0));
  return {
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
  };
}

/** Los tres meses completos antes del de `dia`, del más viejo al más nuevo. */
export function tresMesesAnteriores(
  dia: string,
): { desde: string; hasta: string }[] {
  const meses: { desde: string; hasta: string }[] = [];
  let referencia = dia;
  for (let i = 0; i < 3; i += 1) {
    const m = mesAnterior(referencia);
    meses.unshift(m);
    referencia = m.desde;
  }
  return meses;
}

/** Qué parte del mes ya pasó: 22 de septiembre es 22/30. */
export function fraccionDelMes(dia: string): number {
  const [a, m, d] = dia.split('-').map(Number);
  const dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return d / dias;
}

/** El día anterior. */
export function diaAnterior(dia: string): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** `dia` menos `n` días. */
export function restarDias(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) - n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export interface GastoMes {
  empresaId: string;
  empresa: string;
  cuentaId: string;
  cuenta: string;
  costoUsd: number;
}

export interface IaDisparada extends GastoMes {
  promedioUsd: number;
  veces: number;
}

/**
 * Las empresas que gastan mucho más que de costumbre.
 *
 * Se compara lo que va del mes contra su promedio mensual **proporcional**: a
 * mitad de mes, gastar el promedio entero ya es el doble. Solo cuentan los
 * meses que se midieron completos: el consumo se empezó a medir el
 * 21/09/2026, y antes no hay con qué comparar. Sin historia no se avisa.
 */
export function iaDisparada(
  mes: GastoMes[],
  previo: Map<string, number>,
  mesesMedidos: number,
  fraccion: number,
): IaDisparada[] {
  if (mesesMedidos === 0 || fraccion <= 0) return [];
  return mes
    .map((g) => {
      const promedioUsd = (previo.get(g.empresaId) ?? 0) / mesesMedidos;
      const esperado = promedioUsd * fraccion;
      return {
        ...g,
        promedioUsd,
        veces: esperado > 0 ? g.costoUsd / esperado : 0,
      };
    })
    .filter(
      (g) =>
        g.promedioUsd >= PROMEDIO_IA_MINIMO && g.veces >= VECES_IA_DISPARADA,
    )
    .sort((a, b) => b.veces - a.veces);
}

/** Cuántos de los meses pedidos empiezan después de la primera medición. */
export function mesesMedidos(
  meses: { desde: string }[],
  primeraMedicion: string | null,
): number {
  if (primeraMedicion === null) return 0;
  return meses.filter((m) => m.desde >= primeraMedicion).length;
}

/** El gasto de cada mes, a partir del gasto por día. */
export function gastoPorMes(
  porDia: { dia: string; chatUsd: number; lecturaUsd: number }[],
): { mes: string; usd: number }[] {
  const meses = new Map<string, number>();
  for (const d of porDia) {
    const mes = d.dia.slice(0, 7);
    meses.set(mes, (meses.get(mes) ?? 0) + d.chatUsd + d.lecturaUsd);
  }
  return [...meses.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, usd]) => ({ mes, usd }));
}
