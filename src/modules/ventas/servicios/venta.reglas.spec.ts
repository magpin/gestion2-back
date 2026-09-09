import { calcularLinea, calcularLineas } from './venta.reglas';

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
