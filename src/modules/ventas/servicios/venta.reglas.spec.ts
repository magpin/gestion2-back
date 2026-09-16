import {
  calcularCobro,
  calcularDevolucionPorLinea,
  calcularLinea,
  calcularLineas,
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
