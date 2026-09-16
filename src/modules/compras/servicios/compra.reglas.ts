/**
 * Subtotal, IVA y total de una compra, línea por línea y el documento
 * entero. Sin base de datos.
 *
 * Los `CHECK` de `0031_compras.sql` (`ck_compra_linea_subtotal`,
 * `ck_compra_linea_iva`, `ck_compra_linea_total`) ya sostienen esta
 * aritmética, pero disparan al COMMIT y con un error genérico. Acá se
 * anticipa, para señalar el renglón antes de ir al servidor — mismo
 * criterio que `venta.reglas.ts`.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la
 * base tiene razón.
 *
 * `ivaTarifa` e `ivaDescontable` llegan ya decididas: es el servicio quien
 * resuelve las dos preguntas de `docs/planes/compras-backend.md` (decisión
 * 4) antes de llamar acá —¿el proveedor cobra IVA en esta línea?,
 * ¿ese IVA lo podemos descontar?—; esto solo hace la cuenta con lo que
 * llega, no vuelve a preguntar nada.
 */

/** Lo que pide una línea para calcularse. El servicio pasa más campos y no estorban. */
export interface LineaCompraEntrada {
  cantidad: number;
  /** El costo que dice la factura del proveedor — no un precio de catálogo. */
  costoUnitario: number;
  /** 0, 5 o 19 — ya forzada a 0 si el proveedor no es responsable de IVA. */
  ivaTarifa: number;
  /** `true` si somos responsables de IVA (el IVA de esta línea es descontable). */
  ivaDescontable: boolean;
}

export interface LineaCompraCalculada extends LineaCompraEntrada {
  subtotal: number;
  ivaValor: number;
  total: number;
  /**
   * El costo por unidad que entra al kardex. Igual a `costoUnitario` cuando
   * el IVA es descontable (se separa aparte, no se suma al costo). Cuando
   * NO es descontable, el IVA que el proveedor cobró igual hay que
   * pagarlo, y contablemente se vuelve parte del costo: acá se prorratea
   * de vuelta por unidad (`total / cantidad`) para que
   * `InventarioApi.incrementarPorCompra` reciba el costo real, IVA
   * incluido.
   */
  costoUnitarioKardex: number;
  /**
   * `round(cantidad * costoUnitarioKardex, 2)`, calculado una sola vez
   * acá — es lo que se debita a inventario en el asiento Y lo que
   * `calcularEntrada` va a recalcular como `valor_total` del movimiento.
   * El servicio no lo vuelve a calcular por su cuenta a propósito: los dos
   * lados tienen que leer exactamente el mismo número.
   */
  valorKardex: number;
}

export interface TotalesCompra {
  subtotal: number;
  totalIva: number;
  total: number;
}

/** El dinero se compara en centavos enteros, igual que `venta.reglas.ts`/`asiento.reglas.ts`. */
const CENTAVOS = 100;

/** `producto_movimiento.costo_unitario` es `numeric(18,6)` — la misma precisión que usa el kardex. */
const DECIMALES_COSTO_KARDEX = 6;

function aCentavos(valor: number): number {
  return Math.round(valor * CENTAVOS);
}

function aPesos(centavos: number): number {
  return centavos / CENTAVOS;
}

/**
 * Una línea. El IVA se calcula sobre el subtotal YA redondeado, igual que
 * en una venta: así lo verifica `ck_compra_linea_iva` en la base.
 */
export function calcularLineaCompra(
  entrada: LineaCompraEntrada,
): LineaCompraCalculada {
  const subtotalCentavos = aCentavos(entrada.cantidad * entrada.costoUnitario);
  const ivaCentavos = Math.round((subtotalCentavos * entrada.ivaTarifa) / 100);
  const totalCentavos = subtotalCentavos + ivaCentavos;

  // Redondeado a la misma precisión de `producto_movimiento.costo_unitario`
  // ANTES de que lo use nadie más: si se dejara con más decimales, Postgres
  // lo truncaría solo al guardarlo, y `ck_movimiento_valor_total`
  // (`valor_total = round(cantidad * costo_unitario, 2)`) evaluaría contra
  // un número distinto del que este cálculo usó para armar el débito del
  // asiento — un descuadre de un centavo entre el libro y el kardex.
  // Redondeando acá una sola vez, los dos leen el mismo número.
  const costoUnitarioKardexCrudo = entrada.ivaDescontable
    ? entrada.costoUnitario
    : aPesos(totalCentavos) / entrada.cantidad;
  const factorCosto = 10 ** DECIMALES_COSTO_KARDEX;
  const costoUnitarioKardex =
    Math.round(costoUnitarioKardexCrudo * factorCosto) / factorCosto;

  const valorKardexCentavos = Math.round(
    entrada.cantidad * costoUnitarioKardex * CENTAVOS,
  );

  return {
    ...entrada,
    subtotal: aPesos(subtotalCentavos),
    ivaValor: aPesos(ivaCentavos),
    total: aPesos(totalCentavos),
    costoUnitarioKardex,
    valorKardex: aPesos(valorKardexCentavos),
  };
}

/**
 * Todas las líneas de un documento, y sus totales.
 *
 * El servicio no acepta los totales del cliente: los deriva de las líneas,
 * mismo criterio que `venta.reglas.ts`.
 */
export function calcularLineasCompra(entradas: readonly LineaCompraEntrada[]): {
  lineas: LineaCompraCalculada[];
  totales: TotalesCompra;
} {
  const lineas = entradas.map(calcularLineaCompra);

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

/** La suma de lo retenido, en centavos exactos — no arrastra el flotante crudo. */
export function totalRetenciones(
  retenciones: readonly { valor: number }[],
): number {
  const centavos = retenciones.reduce((t, r) => t + aCentavos(r.valor), 0);
  return aPesos(centavos);
}

/** Lo que efectivamente se le paga al proveedor: el total, menos lo retenido. */
export function netoAPagar(total: number, retenido: number): number {
  return aPesos(aCentavos(total) - aCentavos(retenido));
}

/**
 * La suma de los renglones de un pago. Se suma en centavos enteros por lo
 * mismo que el resto del archivo: `0.1 + 0.2` no da `0.3`, y un reparto de
 * tres renglones podría no cuadrar contra el saldo por una diferencia que no
 * existe.
 */
export function sumarPagos(valores: readonly number[]): number {
  return aPesos(valores.reduce((total, v) => total + aCentavos(v), 0));
}

/**
 * Cuánto queda pagado tras que el proveedor nos devuelva plata.
 *
 * Espejo de `calcularDevolucionCobro` de ventas: la compra vale igual, lo que
 * cambia es cuánto se le pagó. No puede devolver más de lo que recibió.
 */
export type ResultadoDevolucionPago =
  { ok: true; montoPagado: number } | { ok: false; motivo: string };

export function calcularDevolucionPago(
  montoPagadoActual: number,
  valor: number,
): ResultadoDevolucionPago {
  const cobradoCentavos = aCentavos(montoPagadoActual);

  if (cobradoCentavos === 0) {
    return {
      ok: false,
      motivo: 'A esta compra no se le ha pagado nada; no hay qué devolver.',
    };
  }
  if (aCentavos(valor) > cobradoCentavos) {
    return {
      ok: false,
      motivo: `A esta compra solo se le pagaron ${montoPagadoActual}; no se pueden devolver ${valor}.`,
    };
  }

  return { ok: true, montoPagado: aPesos(cobradoCentavos - aCentavos(valor)) };
}

/**
 * Cuánto queda pagado tras un pago. Rechaza si el valor supera lo que
 * falta por pagar — anticipa `ck_compra_monto_pagado` de la base, mismo
 * motivo que `calcularCobro` de `venta.reglas.ts`.
 */
export type ResultadoPago =
  { ok: true; montoPagado: number } | { ok: false; motivo: string };

export function calcularPago(
  netoEfectivo: number,
  montoPagadoActual: number,
  valor: number,
): ResultadoPago {
  const faltaCentavos = aCentavos(netoEfectivo) - aCentavos(montoPagadoActual);

  // Espejo de `calcularCobro`: desde el paso 11 llega el neto efectivo —el
  // neto a pagar menos las notas crédito del proveedor y más las débito—, y
  // puede quedar por debajo de lo ya pagado. Esa diferencia se la devuelve el
  // proveedor, no se le paga.
  if (faltaCentavos < 0) {
    return {
      ok: false,
      motivo: `Esta compra tiene ${aPesos(-faltaCentavos)} a favor nuestro; eso lo devuelve el proveedor, no se le paga.`,
    };
  }
  if (faltaCentavos === 0) {
    return { ok: false, motivo: 'Esta compra ya está pagada por completo.' };
  }
  if (aCentavos(valor) > faltaCentavos) {
    return {
      ok: false,
      motivo: `Solo faltan ${aPesos(faltaCentavos)} por pagar de esta compra; no se puede pagar ${valor}.`,
    };
  }

  return {
    ok: true,
    montoPagado: aPesos(aCentavos(montoPagadoActual) + aCentavos(valor)),
  };
}
