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
  saldoEfectivo: number,
  montoPagadoActual: number,
  valor: number,
): ResultadoCobro {
  const faltaCentavos = aCentavos(saldoEfectivo) - aCentavos(montoPagadoActual);

  // Desde el paso 11 lo que llega acá es el saldo efectivo —el total menos
  // las notas crédito y más las débito—, y puede quedar por debajo de lo ya
  // cobrado: la factura se cobró entera y después le llegó una nota crédito.
  // Eso no es un pendiente en rojo, es plata del cliente que hay que
  // devolverle, y devolverla es otra operación (paso 13).
  if (faltaCentavos < 0) {
    return {
      ok: false,
      motivo: `Esta factura tiene ${aPesos(-faltaCentavos)} a favor del cliente; eso se devuelve, no se cobra.`,
    };
  }
  if (faltaCentavos === 0) {
    return { ok: false, motivo: 'Esta factura ya está cobrada por completo.' };
  }
  if (aCentavos(valor) > faltaCentavos) {
    return {
      ok: false,
      motivo: `Solo faltan ${aPesos(faltaCentavos)} por cobrar de esta factura; no se puede cobrar ${valor}.`,
    };
  }

  return {
    ok: true,
    montoPagado: aPesos(aCentavos(montoPagadoActual) + aCentavos(valor)),
  };
}

/**
 * La suma de los renglones de un cobro. Se suma en centavos enteros por lo
 * mismo que el resto del archivo: `0.1 + 0.2` no da `0.3`, y un reparto de
 * tres renglones podría no cuadrar contra el saldo por una diferencia que no
 * existe.
 */
export function sumarPagos(valores: readonly number[]): number {
  return aPesos(valores.reduce((total, v) => total + aCentavos(v), 0));
}

/**
 * Si esta línea se está vendiendo por debajo de lo que costó.
 *
 * Se compara contra el **costo promedio** —con el que la mercancía sale del
 * kardex— y no contra la última compra: el promedio es la pérdida contable
 * real de esta venta, la última compra es a cuánto habría que reponerla, que
 * es un aviso distinto y no bloquea nada.
 *
 * Vender con pérdida a veces hace falta —liquidar mercancía vieja, cerrar un
 * negocio grande—, así que esto no dice "no se puede": dice "esto pierde
 * tanto", y quién decide es el servicio.
 */
export type ResultadoMargen =
  | { bajoCosto: false }
  | { bajoCosto: true; perdidaUnitaria: number; perdidaTotal: number };

export function evaluarMargen(
  precioUnitario: number,
  costoUnitario: number,
  cantidad: number,
): ResultadoMargen {
  const perdidaCentavos = aCentavos(costoUnitario) - aCentavos(precioUnitario);
  if (perdidaCentavos <= 0) return { bajoCosto: false };

  return {
    bajoCosto: true,
    perdidaUnitaria: aPesos(perdidaCentavos),
    perdidaTotal: aPesos(Math.round(perdidaCentavos * cantidad)),
  };
}

/**
 * Cuánto queda cobrado tras devolverle plata al cliente.
 *
 * Distinto de la nota crédito: allá la factura pasa a valer menos, acá vale
 * igual y lo que cambia es cuánto se cobró. No se puede devolver más de lo
 * que entró —eso no sería una devolución, sería un préstamo—.
 */
export type ResultadoDevolucionCobro =
  { ok: true; montoPagado: number } | { ok: false; motivo: string };

export function calcularDevolucionCobro(
  montoPagadoActual: number,
  valor: number,
): ResultadoDevolucionCobro {
  const cobradoCentavos = aCentavos(montoPagadoActual);

  if (cobradoCentavos === 0) {
    return {
      ok: false,
      motivo: 'De esta factura no se ha cobrado nada; no hay qué devolver.',
    };
  }
  if (aCentavos(valor) > cobradoCentavos) {
    return {
      ok: false,
      motivo: `De esta factura solo se cobraron ${montoPagadoActual}; no se pueden devolver ${valor}.`,
    };
  }

  return { ok: true, montoPagado: aPesos(cobradoCentavos - aCentavos(valor)) };
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

/**
 * Si la forma de pago de una factura nueva cuadra con lo que trae, y cuánto
 * lleva cada renglón.
 *
 * **Contado es pagada entera, en el acto.** Los renglones tienen que cubrir
 * exactamente lo que queda por cobrar —el total menos lo retenido—: un abono
 * parcial al facturar es una venta a crédito con un primer cobro, y se
 * registra así, con `cobrar` después. Mezclar las dos cosas dejaría una
 * factura "de contado" con saldo pendiente, que no es ni lo uno ni lo otro.
 *
 * **Un renglón puede venir sin valor, y se lleva lo que falte.** Quien factura
 * no conoce el total al centavo —el IVA y las retenciones los resuelve el
 * servidor—, así que "todo en efectivo" es un renglón sin valor, y "50.000 en
 * efectivo y el resto por transferencia" es uno con valor y otro sin. Solo uno
 * puede quedar abierto: con dos, no habría cómo decidir cuánto va a cada uno.
 *
 * Crédito no lleva renglones: si vinieran, alguien creyó que estaba cobrando
 * y la plata no entraría a ninguna parte.
 */
export type ResultadoFormaPago =
  { ok: true; valores: number[] } | { ok: false; motivo: string };

export function validarFormaPago(
  formaPago: 'CREDITO' | 'CONTADO',
  pagos: readonly (number | undefined)[] | undefined,
  porCobrar: number,
): ResultadoFormaPago {
  const renglones = pagos ?? [];
  if (formaPago === 'CREDITO') {
    return renglones.length === 0
      ? { ok: true, valores: [] }
      : {
          ok: false,
          motivo:
            'Una factura a crédito no lleva medios de pago: se cobra después.',
        };
  }
  if (renglones.length === 0) {
    return {
      ok: false,
      motivo: 'Una factura de contado necesita al menos un medio de pago.',
    };
  }

  const abiertos = renglones.filter((r) => r === undefined).length;
  if (abiertos > 1) {
    return {
      ok: false,
      motivo:
        'Solo un medio de pago puede quedar sin valor: es el que se lleva lo que falte.',
    };
  }

  const porCobrarCentavos = aCentavos(porCobrar);
  const fijadosCentavos = renglones.reduce<number>(
    (t, r) => t + (r === undefined ? 0 : aCentavos(r)),
    0,
  );

  if (abiertos === 0) {
    if (fijadosCentavos !== porCobrarCentavos) {
      return {
        ok: false,
        motivo: `De contado se cobra entera: los medios de pago suman ${aPesos(fijadosCentavos)} y la factura es por ${porCobrar}.`,
      };
    }
    return { ok: true, valores: renglones.map((r) => r as number) };
  }

  const restoCentavos = porCobrarCentavos - fijadosCentavos;
  if (restoCentavos <= 0) {
    return {
      ok: false,
      motivo: `Los medios con valor ya suman ${aPesos(fijadosCentavos)} y la factura es por ${porCobrar}: al que quedó sin valor no le queda nada.`,
    };
  }
  return {
    ok: true,
    valores: renglones.map((r) =>
      r === undefined ? aPesos(restoCentavos) : r,
    ),
  };
}

/**
 * El precio de una línea de producto: el digitado en la línea si viene —el
 * que se pactó con el cliente—, y si no, el de lista vigente. Un precio de
 * lista en cero cuenta como que no hay: la línea saldría en cero. Sin
 * ninguno de los dos, `null`: el servicio dice qué producto es.
 */
export function resolverPrecio(
  digitado: number | undefined,
  deLista: number | null,
): number | null {
  if (digitado !== undefined) return digitado;
  if (deLista !== null && deLista > 0) return deLista;
  return null;
}
