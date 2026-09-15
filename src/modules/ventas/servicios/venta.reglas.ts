/**
 * Subtotal, IVA y total de una venta, línea por línea y el documento
 * entero. Sin base de datos.
 *
 * Los `CHECK` de `0027_ventas.sql` (`ck_linea_subtotal`, `ck_linea_iva`,
 * `ck_linea_total`) ya sostienen esta aritmética, pero disparan al COMMIT y
 * con un error genérico que no dice cuál línea del documento está mal. Acá
 * se anticipa, para señalar el renglón antes de ir al servidor.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la
 * base tiene razón.
 *
 * `ivaTarifa` llega ya decidida: es el servicio quien la fuerza a `0` en
 * cada línea cuando `NucleoApi.esResponsableDeIva` es `false` — acá no se
 * vuelve a preguntar, solo se sostiene la cuenta con lo que llega.
 */

/** Lo que pide una línea para calcularse. El servicio pasa más campos y no estorban. */
export interface LineaVentaEntrada {
  cantidad: number;
  precioUnitario: number;
  /** 0, 5 o 19 — o lo que el servicio haya decidido antes de llamar acá. */
  ivaTarifa: number;
}

export interface LineaVentaCalculada extends LineaVentaEntrada {
  subtotal: number;
  ivaValor: number;
  total: number;
}

export interface TotalesVenta {
  subtotal: number;
  totalIva: number;
  total: number;
}

/** El dinero se compara en centavos enteros, igual que `asiento.reglas.ts`. */
const CENTAVOS = 100;

/**
 * Redondea a centavos antes de sumar.
 *
 * `0.1 + 0.2 !== 0.3` en punto flotante, y una venta de líneas chicas
 * quedaría descuadrada contra la base por una diferencia que no existe. La
 * base usa `numeric(18,2)`, que sí es exacto; acá se replica redondeando a
 * centavos antes de cualquier suma.
 */
function aCentavos(valor: number): number {
  return Math.round(valor * CENTAVOS);
}

function aPesos(centavos: number): number {
  return centavos / CENTAVOS;
}

/**
 * Una línea. El IVA se calcula sobre el subtotal YA redondeado —no sobre
 * `cantidad * precioUnitario` crudo—, porque así lo verifica
 * `ck_linea_iva` en la base: `iva_valor = round(subtotal * iva_tarifa / 100, 2)`,
 * y `subtotal` ahí ya es la columna `numeric(18,2)`, no el cálculo intermedio.
 */
export function calcularLinea(entrada: LineaVentaEntrada): LineaVentaCalculada {
  const subtotalCentavos = aCentavos(entrada.cantidad * entrada.precioUnitario);
  const ivaCentavos = Math.round((subtotalCentavos * entrada.ivaTarifa) / 100);

  return {
    ...entrada,
    subtotal: aPesos(subtotalCentavos),
    ivaValor: aPesos(ivaCentavos),
    total: aPesos(subtotalCentavos + ivaCentavos),
  };
}

/**
 * Todas las líneas de un documento, y sus totales.
 *
 * El servicio no acepta los totales del cliente: los deriva de las líneas.
 * Aceptarlos permitiría guardar una cabecera que dice una cosa y unas
 * líneas que dicen otra, y el `CHECK` lo rechazaría al COMMIT con un
 * mensaje que ya no puede señalar dónde.
 */
export function calcularLineas(entradas: readonly LineaVentaEntrada[]): {
  lineas: LineaVentaCalculada[];
  totales: TotalesVenta;
} {
  const lineas = entradas.map(calcularLinea);

  const subtotalCentavos = lineas.reduce(
    (t, l) => t + aCentavos(l.subtotal),
    0,
  );
  const ivaCentavos = lineas.reduce((t, l) => t + aCentavos(l.ivaValor), 0);

  return {
    lineas,
    totales: {
      subtotal: aPesos(subtotalCentavos),
      totalIva: aPesos(ivaCentavos),
      total: aPesos(subtotalCentavos + ivaCentavos),
    },
  };
}

/**
 * Cuánto queda pagado tras un cobro. Rechaza si el valor supera lo que
 * falta por cobrar — anticipa `ck_venta_monto_pagado` de la base, mismo
 * motivo que el resto de este archivo: un mensaje legible en vez de la
 * violación de `CHECK` genérica.
 */
export type ResultadoCobro =
  { ok: true; montoPagado: number } | { ok: false; motivo: string };

export function calcularCobro(
  total: number,
  montoPagadoActual: number,
  valor: number,
): ResultadoCobro {
  const nuevoMontoPagadoCentavos =
    aCentavos(montoPagadoActual) + aCentavos(valor);

  if (nuevoMontoPagadoCentavos > aCentavos(total)) {
    const saldoPendiente = aPesos(
      aCentavos(total) - aCentavos(montoPagadoActual),
    );
    return {
      ok: false,
      motivo: `Solo faltan ${saldoPendiente} por cobrar de esta factura; no se puede cobrar ${valor}.`,
    };
  }

  return { ok: true, montoPagado: aPesos(nuevoMontoPagadoCentavos) };
}

/**
 * Cuánto de una línea de factura se puede devolver todavía.
 *
 * Hasta el paso 8 la nota crédito era todo o nada: copiaba la factura entera
 * y reversaba el 100%. Con notas parciales hay que llevar la cuenta —una
 * factura puede recibir varias, y entre todas no pueden devolver más de lo
 * que se vendió—. `yaDevuelto` es la suma de lo que las notas anteriores no
 * anuladas ya sacaron de esa misma línea.
 */
export type ResultadoDevolucion =
  { ok: true; pendienteLuego: number } | { ok: false; motivo: string };

export function calcularDevolucionPorLinea(
  cantidadFacturada: number,
  yaDevuelto: number,
  cantidadPedida: number,
): ResultadoDevolucion {
  const pendiente = cantidadFacturada - yaDevuelto;

  if (cantidadPedida <= 0) {
    return {
      ok: false,
      motivo: 'La cantidad a devolver tiene que ser mayor a cero.',
    };
  }
  if (pendiente <= 0) {
    return {
      ok: false,
      motivo: `De esa línea ya se devolvió todo (${cantidadFacturada}); no queda nada por devolver.`,
    };
  }
  if (cantidadPedida > pendiente) {
    return {
      ok: false,
      motivo: `De esa línea quedan ${pendiente} por devolver de las ${cantidadFacturada} facturadas; no se pueden devolver ${cantidadPedida}.`,
    };
  }

  return { ok: true, pendienteLuego: pendiente - cantidadPedida };
}
