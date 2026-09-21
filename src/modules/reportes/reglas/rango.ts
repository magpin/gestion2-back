/**
 * Los atajos de fecha de un reporte, resueltos contra un día concreto.
 *
 * **Se resuelven en el servidor y no en el navegador**, por dos razones. La
 * zona horaria de Colombia ya está resuelta acá —`hoyEnColombia`—, y un
 * navegador en otro huso llamaría «este mes» a otro mes en los bordes. Y «el
 * período contable en curso» no lo sabe el navegador: hay que ir a buscarlo a
 * la base.
 *
 * Puro: el día de referencia entra como parámetro. Así los bordes —el 31, el
 * 1 de enero, un año bisiesto— se prueban sin tocar el reloj.
 */

export type Atajo = 'ESTE_MES' | 'MES_PASADO' | 'ESTE_ANIO' | 'PERIODO';

export const ATAJOS: readonly Atajo[] = [
  'ESTE_MES',
  'MES_PASADO',
  'ESTE_ANIO',
  'PERIODO',
];

export const ETIQUETA_ATAJO: Record<Atajo, string> = {
  ESTE_MES: 'este mes',
  MES_PASADO: 'el mes pasado',
  ESTE_ANIO: 'este año',
  PERIODO: 'el período contable en curso',
};

export interface Rango {
  desde: string;
  hasta: string;
  /**
   * Cómo se eligió. Va impreso en la hoja porque **decide si sirve dentro de
   * seis meses**: «este mes» vuelve a correr sobre otro mes, una fecha escrita
   * a mano vuelve sobre la misma.
   */
  etiqueta: string;
  /** `true` si se eligió con un atajo. Lo que la pantalla tiene que mostrar. */
  relativo: boolean;
}

const dosDigitos = (n: number): string => String(n).padStart(2, '0');

/** El último día de un mes, sin depender de `Date` y sus meses de base cero. */
export function ultimoDiaDe(anio: number, mes: number): number {
  // El día cero del mes siguiente es el último del mes pedido, y `Date` ya sabe
  // de bisiestos. `Date.UTC` y no `new Date(...)`: con la hora local, un
  // servidor al oeste de Greenwich devuelve el día anterior.
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * El rango de un atajo. `PERIODO` no se resuelve acá porque necesita la base:
 * lo resuelve el servicio y cae a `ESTE_MES` si no hay período abierto.
 */
export function resolver(atajo: Exclude<Atajo, 'PERIODO'>, hoy: string): Rango {
  const [anio, mes] = hoy.split('-').map(Number);

  if (atajo === 'ESTE_ANIO') {
    return {
      desde: `${anio}-01-01`,
      // **Hasta hoy y no hasta el 31 de diciembre.** Un reporte «de este año»
      // que llega a diciembre incluiría meses que todavía no pasaron, y el
      // promedio por día saldría mal sin que nadie lo note.
      hasta: hoy,
      etiqueta: ETIQUETA_ATAJO.ESTE_ANIO,
      relativo: true,
    };
  }

  const esEsteMes = atajo === 'ESTE_MES';
  const anioDelMes = esEsteMes || mes > 1 ? anio : anio - 1;
  const numeroMes = esEsteMes ? mes : mes > 1 ? mes - 1 : 12;

  return {
    desde: `${anioDelMes}-${dosDigitos(numeroMes)}-01`,
    // El mes en curso llega hasta hoy; uno pasado, hasta su último día.
    hasta: esEsteMes
      ? hoy
      : `${anioDelMes}-${dosDigitos(numeroMes)}-${dosDigitos(ultimoDiaDe(anioDelMes, numeroMes))}`,
    etiqueta: ETIQUETA_ATAJO[atajo],
    relativo: true,
  };
}

/** Un rango escrito a mano. Se guarda tal cual y no se mueve nunca más. */
export function aMano(desde: string, hasta: string): Rango {
  return { desde, hasta, etiqueta: 'fechas fijas', relativo: false };
}

/**
 * Los atajos de una **fecha de corte**, que no son los de un rango.
 *
 * Un rango pregunta «de qué fechas»; un corte pregunta «a qué día». La cartera
 * es una foto a una fecha, y las fechas que un contador usa para esa foto son
 * otras: hoy, el cierre del mes pasado, el cierre del último período que se
 * cerró. Mezclarlos con los de rango —«este mes» como corte— no significaría
 * nada.
 */
export type AtajoCorte =
  'HOY' | 'CIERRE_MES_PASADO' | 'CIERRE_PERIODO_ANTERIOR';

export const ATAJOS_CORTE: readonly AtajoCorte[] = [
  'HOY',
  'CIERRE_MES_PASADO',
  'CIERRE_PERIODO_ANTERIOR',
];

export const ETIQUETA_ATAJO_CORTE: Record<AtajoCorte, string> = {
  HOY: 'hoy',
  CIERRE_MES_PASADO: 'el cierre del mes pasado',
  CIERRE_PERIODO_ANTERIOR: 'el cierre del período anterior',
};

export interface Corte {
  corte: string;
  etiqueta: string;
  /** `true` si se eligió con un atajo: vuelve a correr sobre otra fecha. */
  relativo: boolean;
}

/**
 * El corte de un atajo. `CIERRE_PERIODO_ANTERIOR` necesita la base —cuál fue
 * el último período cerrado— y lo resuelve el controlador.
 */
export function resolverCorte(
  atajo: Exclude<AtajoCorte, 'CIERRE_PERIODO_ANTERIOR'>,
  hoy: string,
): Corte {
  if (atajo === 'HOY') {
    return { corte: hoy, etiqueta: ETIQUETA_ATAJO_CORTE.HOY, relativo: true };
  }
  const [anio, mes] = hoy.split('-').map(Number);
  const anioPasado = mes > 1 ? anio : anio - 1;
  const mesPasado = mes > 1 ? mes - 1 : 12;
  return {
    corte: `${anioPasado}-${dosDigitos(mesPasado)}-${dosDigitos(ultimoDiaDe(anioPasado, mesPasado))}`,
    etiqueta: ETIQUETA_ATAJO_CORTE.CIERRE_MES_PASADO,
    relativo: true,
  };
}

/** Una fecha de corte escrita a mano. No se mueve. */
export function corteAMano(corte: string): Corte {
  return { corte, etiqueta: 'fecha fija', relativo: false };
}
