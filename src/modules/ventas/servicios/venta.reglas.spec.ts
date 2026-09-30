import {
  calcularCobro,
  calcularDevolucionCobro,
  calcularDevolucionPorLinea,
  evaluarMargen,
  calcularLinea,
  calcularLineas,
  resolverPrecio,
  sumarPagos,
  validarFormaPago,
} from './venta.reglas';

describe('calcularLinea', () => {
  it('con IVA: liquida sobre el subtotal', () => {
    const linea = calcularLinea({
      cantidad: 2,
      precioUnitario: 50000,
      ivaTarifa: 19,
    });

    expect(linea.subtotal).toBe(100000);
    expect(linea.ivaValor).toBe(19000);
    expect(linea.total).toBe(119000);
  });

  it('sin IVA (empresa no responsable, tarifa ya forzada a 0): el total es el subtotal', () => {
    const linea = calcularLinea({
      cantidad: 3,
      precioUnitario: 15000,
      ivaTarifa: 0,
    });

    expect(linea.subtotal).toBe(45000);
    expect(linea.ivaValor).toBe(0);
    expect(linea.total).toBe(45000);
  });

  it('redondea a centavos, no arrastra el flotante crudo', () => {
    // 1.5 * 333.33 = 499.995 — redondea a 500.00, no se queda en 499.99.
    const linea = calcularLinea({
      cantidad: 1.5,
      precioUnitario: 333.33,
      ivaTarifa: 0,
    });

    expect(linea.subtotal).toBe(500);
  });

  it('el IVA se calcula sobre el subtotal ya redondeado, no sobre cantidad*precio crudo', () => {
    // subtotal = round(3333 * 100.01 / ... ) da un subtotal con dos decimales
    // exactos; el IVA tiene que salir de ESE número, igual que `ck_linea_iva`
    // en la base lee la columna `subtotal`, no recalcula desde cero.
    const linea = calcularLinea({
      cantidad: 1,
      precioUnitario: 100.01,
      ivaTarifa: 19,
    });

    expect(linea.subtotal).toBe(100.01);
    expect(linea.ivaValor).toBe(19);
    expect(linea.total).toBe(119.01);
  });
});

describe('calcularLineas', () => {
  it('tarifa mixta en el mismo documento: cada línea liquida la suya, los totales las suman', () => {
    const { lineas, totales } = calcularLineas([
      { cantidad: 1, precioUnitario: 100000, ivaTarifa: 19 }, // 100000 + 19000
      { cantidad: 1, precioUnitario: 50000, ivaTarifa: 5 }, //  50000 +  2500
      { cantidad: 1, precioUnitario: 20000, ivaTarifa: 0 }, //  20000 +     0
    ]);

    expect(lineas).toHaveLength(3);
    expect(lineas[0].ivaValor).toBe(19000);
    expect(lineas[1].ivaValor).toBe(2500);
    expect(lineas[2].ivaValor).toBe(0);

    expect(totales).toEqual({
      subtotal: 170000,
      totalIva: 21500,
      total: 191500,
    });
  });

  it('un documento sin líneas da totales en cero, no un error', () => {
    // El rechazo de "un documento necesita al menos una línea" es una regla
    // del servicio, no de este cálculo puro — acá solo se suma lo que hay.
    const { lineas, totales } = calcularLineas([]);

    expect(lineas).toEqual([]);
    expect(totales).toEqual({ subtotal: 0, totalIva: 0, total: 0 });
  });

  it('los totales se acumulan en centavos, no arrastran el redondeo de cada línea', () => {
    // Tres líneas de 0.33 con 19% de IVA: cada una liquida 0.0627 → redondea
    // a 0.06. Sumar los CENTAVOS ya redondeados de cada línea (3 × 6 = 18)
    // da el mismo resultado que sumar primero y redondear después acá,
    // porque no hay arrastre entre líneas — es la garantía que se prueba.
    const { totales } = calcularLineas([
      { cantidad: 1, precioUnitario: 0.33, ivaTarifa: 19 },
      { cantidad: 1, precioUnitario: 0.33, ivaTarifa: 19 },
      { cantidad: 1, precioUnitario: 0.33, ivaTarifa: 19 },
    ]);

    expect(totales.subtotal).toBe(0.99);
    expect(totales.totalIva).toBe(0.18);
    expect(totales.total).toBe(1.17);
  });
});

describe('calcularCobro', () => {
  it('un cobro parcial deja el monto pagado corrido, sin tocar el resto', () => {
    const resultado = calcularCobro(119000, 0, 50000);

    expect(resultado).toEqual({ ok: true, montoPagado: 50000 });
  });

  it('el segundo cobro se suma al primero', () => {
    const resultado = calcularCobro(119000, 50000, 69000);

    expect(resultado).toEqual({ ok: true, montoPagado: 119000 });
  });

  it('cobrar exactamente el saldo pendiente deja la factura saldada', () => {
    const resultado = calcularCobro(119000, 119000 - 30000, 30000);

    expect(resultado).toEqual({ ok: true, montoPagado: 119000 });
  });

  it('rechaza un cobro que deje el monto pagado por encima del total', () => {
    const resultado = calcularCobro(119000, 100000, 20000);

    expect(resultado).toEqual({
      ok: false,
      motivo:
        'Solo faltan 19000 por cobrar de esta factura; no se puede cobrar 20000.',
    });
  });

  it('rechaza cobrar una factura ya saldada', () => {
    const resultado = calcularCobro(119000, 119000, 1);

    expect(resultado.ok).toBe(false);
  });

  it('cobrada entera y con nota crédito después: no hay pendiente, hay saldo a favor', () => {
    // 119.000 cobrados, y después una nota crédito de 19.000 deja el saldo
    // efectivo en 100.000. Los 19.000 de diferencia se devuelven (paso 13).
    const resultado = calcularCobro(100000, 119000, 1000);

    expect(resultado).toEqual({
      ok: false,
      motivo:
        'Esta factura tiene 19000 a favor del cliente; eso se devuelve, no se cobra.',
    });
  });
});

describe('calcularDevolucionPorLinea', () => {
  it('deja devolver lo que queda y dice cuánto quedaría después', () => {
    const r = calcularDevolucionPorLinea(10, 4, 3);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pendienteLuego).toBe(3);
  });

  it('rechaza pasarse de lo pendiente, diciendo cuánto queda', () => {
    const r = calcularDevolucionPorLinea(10, 4, 7);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe(
      'De esa línea quedan 6 por devolver de las 10 facturadas; no se pueden devolver 7.',
    );
  });

  it('rechaza si ya se devolvió todo', () => {
    const r = calcularDevolucionPorLinea(10, 10, 1);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/ya se devolvió todo/);
  });

  it('rechaza cantidad cero o negativa', () => {
    expect(calcularDevolucionPorLinea(10, 0, 0).ok).toBe(false);
    expect(calcularDevolucionPorLinea(10, 0, -1).ok).toBe(false);
  });
});

describe('sumarPagos', () => {
  it('suma los renglones de un reparto', () => {
    expect(sumarPagos([19000, 100000])).toBe(119000);
  });

  it('no arrastra el flotante: 0.1 + 0.2 da 0.3, no 0.30000000000000004', () => {
    expect(sumarPagos([0.1, 0.2])).toBe(0.3);
  });

  it('un solo renglón es ese mismo valor', () => {
    expect(sumarPagos([50000])).toBe(50000);
  });
});

describe('calcularDevolucionCobro', () => {
  it('devuelve una parte y deja el resto cobrado', () => {
    expect(calcularDevolucionCobro(119000, 19000)).toEqual({
      ok: true,
      montoPagado: 100000,
    });
  });

  it('devolver todo lo cobrado deja la factura sin cobrar', () => {
    expect(calcularDevolucionCobro(119000, 119000)).toEqual({
      ok: true,
      montoPagado: 0,
    });
  });

  it('rechaza devolver más de lo que entró', () => {
    expect(calcularDevolucionCobro(50000, 60000)).toEqual({
      ok: false,
      motivo:
        'De esta factura solo se cobraron 50000; no se pueden devolver 60000.',
    });
  });

  it('rechaza si no se cobró nada', () => {
    const r = calcularDevolucionCobro(0, 1000);
    expect(r.ok).toBe(false);
  });
});

describe('evaluarMargen', () => {
  it('por encima del costo no dice nada', () => {
    expect(evaluarMargen(50000, 17961.8, 3)).toEqual({ bajoCosto: false });
  });

  it('al costo exacto tampoco: no se pierde', () => {
    expect(evaluarMargen(17961.8, 17961.8, 1)).toEqual({ bajoCosto: false });
  });

  it('por debajo, dice cuánto se pierde por unidad y en total', () => {
    expect(evaluarMargen(10000, 17961.8, 3)).toEqual({
      bajoCosto: true,
      perdidaUnitaria: 7961.8,
      perdidaTotal: 23885.4,
    });
  });
});

describe('validarFormaPago', () => {
  it('crédito sin renglones pasa; con renglones no', () => {
    expect(validarFormaPago('CREDITO', undefined, 119000)).toEqual({
      ok: true,
      valores: [],
    });
    expect(validarFormaPago('CREDITO', [119000], 119000).ok).toBe(false);
  });

  it('contado sin renglones se rechaza', () => {
    expect(validarFormaPago('CONTADO', [], 119000).ok).toBe(false);
  });

  it('contado con todos los valores tiene que sumar exacto, sin tropezar con el flotante', () => {
    expect(validarFormaPago('CONTADO', [0.1, 0.2], 0.3)).toEqual({
      ok: true,
      valores: [0.1, 0.2],
    });
    expect(validarFormaPago('CONTADO', [100000], 119000)).toEqual({
      ok: false,
      motivo:
        'De contado se cobra entera: los medios de pago suman 100000 y la factura es por 119000.',
    });
    expect(validarFormaPago('CONTADO', [119000.01], 119000).ok).toBe(false);
  });

  it('un renglón sin valor se lleva todo', () => {
    expect(validarFormaPago('CONTADO', [undefined], 344981.5)).toEqual({
      ok: true,
      valores: [344981.5],
    });
  });

  it('repartido: el renglón sin valor se lleva lo que falte, en centavos exactos', () => {
    expect(validarFormaPago('CONTADO', [50000.1, undefined], 119000.3)).toEqual(
      {
        ok: true,
        valores: [50000.1, 69000.2],
      },
    );
  });

  it('dos renglones sin valor se rechazan: no hay cómo repartir', () => {
    expect(validarFormaPago('CONTADO', [undefined, undefined], 119000).ok).toBe(
      false,
    );
  });

  it('si los valores ya cubren todo, al renglón abierto no le queda nada', () => {
    expect(validarFormaPago('CONTADO', [119000, undefined], 119000).ok).toBe(
      false,
    );
    expect(validarFormaPago('CONTADO', [120000, undefined], 119000).ok).toBe(
      false,
    );
  });
});

describe('resolverPrecio', () => {
  it('el digitado manda sobre el de lista', () => {
    expect(resolverPrecio(250000, 289900)).toBe(250000);
  });

  it('sin digitar, el de lista', () => {
    expect(resolverPrecio(undefined, 289900)).toBe(289900);
  });

  it('sin ninguno de los dos, null', () => {
    expect(resolverPrecio(undefined, null)).toBeNull();
  });

  it('un precio de lista en cero cuenta como que no hay', () => {
    expect(resolverPrecio(undefined, 0)).toBeNull();
  });
});
