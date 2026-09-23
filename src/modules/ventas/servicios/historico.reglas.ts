/**
 * Qué se acepta de una factura de venta histórica. Sin base de datos.
 *
 * Fase 10 de `docs/planes/maria-facturas-y-errores.md`. Una histórica es una
 * factura que se emitió antes de usar el sistema: se carga **con su número y
 * su fecha originales, sin tocar la resolución, y sin asiento ni kardex** —lo
 * que vendió ya está en los saldos iniciales—.
 *
 * Lo delicado no es la aritmética sino **el número**: es el de la DIAN, y un
 * número mal leído o repetido es un problema de cumplimiento, no de datos.
 */

import { calcularLineas } from './venta.reglas';

/** Un número de factura partido como lo guarda `venta_documento`. */
export interface NumeroFactura {
  prefijo: string | null;
  consecutivo: number;
}

/** El prefijo de una resolución: letras y dígitos, hasta cuatro según la DIAN. */
const LARGO_PREFIJO = 10;
/** `venta_documento.consecutivo` es `int`. */
const CONSECUTIVO_MAXIMO = 2_147_483_647;

/**
 * «FE-0123», «FE 123», «SETT13», «FE1-123», «000456» → prefijo y consecutivo.
 *
 * El consecutivo son los dígitos del final; el prefijo, lo de antes, sin el
 * guion ni los espacios que lo separan. Los ceros a la izquierda no cuentan:
 * «FE-0123» y «FE-123» son la misma factura. `null` si no termina en dígitos:
 * sin consecutivo no hay número de la DIAN.
 */
export function partirNumero(numero: string): NumeroFactura | null {
  const limpio = numero.trim().toUpperCase();
  const partes = /^(.*?)[\s-]*(\d+)$/.exec(limpio);
  if (partes === null) return null;
  const [, prefijo, digitos] = partes;
  const consecutivo = Number(digitos);
  if (consecutivo <= 0 || consecutivo > CONSECUTIVO_MAXIMO) return null;
  if (prefijo.length > LARGO_PREFIJO || /[^A-Z0-9]/.test(prefijo)) return null;
  return { prefijo: prefijo === '' ? null : prefijo, consecutivo };
}

/** «FE-123», o «123» sin prefijo: como se muestra en el resto de la aplicación. */
export function numeroComoTexto(n: NumeroFactura): string {
  return n.prefijo === null
    ? String(n.consecutivo)
    : `${n.prefijo}-${n.consecutivo}`;
}

/** Lo que dice la resolución vigente de facturación. */
export interface ResolucionVigente {
  prefijo: string | null;
  rangoDesde: number;
  rangoHasta: number;
  /** El último número que ya usó el sistema. */
  consecutivoActual: number;
}

/**
 * Un número histórico que cae **adelante** del consecutivo de la resolución
 * vigente: el sistema todavía no lo ha usado, y lo va a usar.
 *
 * Si esa factura de verdad se emitió en el sistema anterior, la resolución del
 * sistema está atrasada, y la próxima factura nueva saldría con un número que
 * la DIAN ya recibió. Se rechaza al cargar y se dice qué hacer, en vez de
 * descubrirlo el día que choque al facturar.
 */
export function choqueConResolucion(
  numero: NumeroFactura,
  resoluciones: ResolucionVigente[],
): string | null {
  const choca = resoluciones.find(
    (r) =>
      (r.prefijo ?? '') === (numero.prefijo ?? '') &&
      numero.consecutivo >= r.rangoDesde &&
      numero.consecutivo <= r.rangoHasta &&
      numero.consecutivo > r.consecutivoActual,
  );
  if (choca === undefined) return null;
  return `El número ${numeroComoTexto(numero)} es de la resolución vigente y el sistema todavía no llegó a él (va en el ${choca.consecutivoActual}). Si esa factura ya se emitió, hay que adelantar el consecutivo de la resolución antes de cargarla; si no, el número está mal.`;
}

/** Una factura del archivo, antes de resolver cliente y productos. */
export interface FacturaHistoricaEntrada {
  numero: string;
  fecha: string;
  clienteNit: string;
  lineas: Array<{
    codigoProducto: string;
    cantidad: number;
    /** Antes de IVA: el que se cobró entonces, no el de la lista de hoy. */
    precioUnitario: number;
    ivaTarifa: number;
  }>;
  /** Lo que ya se había cobrado. Lo que falte queda en la cartera. */
  pagado?: number;
}

/**
 * Lo que se puede decir de una factura sin mirar la base: que el número se
 * entienda, que la fecha no sea futura, que las líneas tengan sentido y que no
 * se haya pagado más de lo que vale. Devuelve los problemas, en palabras.
 *
 * **El precio es el de entonces**, a diferencia de una factura nueva: es un
 * hecho que ya pasó, no uno que se está decidiendo.
 */
export function problemasDeFactura(
  f: FacturaHistoricaEntrada,
  hoy: string,
): string[] {
  const problemas: string[] = [];
  if (partirNumero(f.numero) === null) {
    problemas.push(
      `«${f.numero}» no es un número de factura: tiene que terminar en el consecutivo.`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)) {
    problemas.push(`La fecha «${f.fecha}» no es una fecha (aaaa-mm-dd).`);
  } else if (f.fecha > hoy) {
    problemas.push(
      `La fecha ${f.fecha} es futura: una factura histórica ya se emitió.`,
    );
  }
  if (f.clienteNit.replace(/\D/g, '') === '') {
    problemas.push('Falta el NIT o la cédula del cliente.');
  }
  if (f.lineas.length === 0) {
    problemas.push('No tiene líneas.');
  }
  f.lineas.forEach((l, i) => {
    const renglon = `Línea ${i + 1} (${l.codigoProducto || 'sin código'})`;
    if (!(l.cantidad > 0))
      problemas.push(`${renglon}: la cantidad tiene que ser mayor que cero.`);
    if (!(l.precioUnitario >= 0))
      problemas.push(`${renglon}: el precio no puede ser negativo.`);
    if (![0, 5, 19].includes(l.ivaTarifa)) {
      problemas.push(
        `${renglon}: la tarifa de IVA tiene que ser 0, 5 o 19, no ${l.ivaTarifa}.`,
      );
    }
  });

  if (problemas.length === 0 && f.pagado !== undefined) {
    const { totales } = calcularLineas(f.lineas);
    if (f.pagado < 0) problemas.push('Lo pagado no puede ser negativo.');
    if (f.pagado > totales.total + 0.005) {
      problemas.push(
        `Dice que se pagaron ${f.pagado} y la factura vale ${totales.total}.`,
      );
    }
  }
  return problemas;
}

/**
 * Los números repetidos dentro del mismo archivo. Se comparan ya partidos:
 * «FE-0123» y «FE123» son la misma factura escrita de dos formas.
 */
export function repetidosEnElArchivo(
  facturas: FacturaHistoricaEntrada[],
): string[] {
  const vistos = new Map<string, number>();
  for (const f of facturas) {
    const n = partirNumero(f.numero);
    if (n === null) continue;
    const llave = numeroComoTexto(n);
    vistos.set(llave, (vistos.get(llave) ?? 0) + 1);
  }
  return [...vistos.entries()]
    .filter(([, veces]) => veces > 1)
    .map(([llave]) => llave);
}
