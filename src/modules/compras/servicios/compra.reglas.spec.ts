import {
  calcularLineaCompra,
  calcularLineasCompra,
  calcularPago,
  netoAPagar,
  totalRetenciones,
} from './compra.reglas';

describe('calcularLineaCompra', () => {
  it('con IVA descontable: el costo de kardex es el mismo de la factura', () => {
    const linea = calcularLineaCompra({
      cantidad: 2,
      costoUnitario: 50000,
      ivaTarifa: 19,
      ivaDescontable: true,
    });

    expect(linea.subtotal).toBe(100000);
    expect(linea.ivaValor).toBe(19000);
    expect(linea.total).toBe(119000);
    expect(linea.costoUnitarioKardex).toBe(50000);
    // Descontable: lo que entra a inventario es el subtotal, sin el IVA.
    expect(linea.valorKardex).toBe(100000);
  });

  it('con IVA NO descontable: el IVA se prorratea de vuelta al costo unitario de kardex', () => {
    // subtotal 100000 + iva 19000 = 119000, sobre 2 unidades: 59500 c/u.
    const linea = calcularLineaCompra({
      cantidad: 2,
      costoUnitario: 50000,
      ivaTarifa: 19,
      ivaDescontable: false,
    });

    expect(linea.subtotal).toBe(100000);
    expect(linea.ivaValor).toBe(19000);
    expect(linea.total).toBe(119000);
    expect(linea.costoUnitarioKardex).toBe(59500);
    // No descontable: lo que entra a inventario es el total, IVA incluido
    // — y coincide exacto con `total` porque cantidad*costoUnitarioKardex
    // reproduce el mismo valor (2 * 59500 = 119000).
    expect(linea.valorKardex).toBe(119000);
  });

  it('valorKardex reproduce el total exacto aun cuando costoUnitarioKardex queda con muchos decimales', () => {
    // total = 100 + 19% = 119, sobre 3 unidades: 39.666666... redondeado a
    // 6 decimales (39.666667) — al multiplicar de vuelta por 3 tiene que
    // seguir dando 119.00, no 118.99 ni 119.01.
    const linea = calcularLineaCompra({
      cantidad: 3,
      costoUnitario: 33.3333,
      ivaTarifa: 19,
      ivaDescontable: false,
    });

    expect(linea.total).toBe(119);
    expect(linea.valorKardex).toBe(119);
  });

  it('sin IVA (proveedor no responsable, tarifa ya forzada a 0): el costo de kardex es el crudo', () => {
    const linea = calcularLineaCompra({
      cantidad: 3,
      costoUnitario: 15000,
      ivaTarifa: 0,
      ivaDescontable: true,
    });

    expect(linea.ivaValor).toBe(0);
    expect(linea.total).toBe(45000);
    expect(linea.costoUnitarioKardex).toBe(15000);
    expect(linea.valorKardex).toBe(45000);
  });

  it('redondea a centavos, no arrastra el flotante crudo', () => {
    // 1.5 * 333.33 = 499.995 — redondea a 500.00, no se queda en 499.99.
    const linea = calcularLineaCompra({
      cantidad: 1.5,
      costoUnitario: 333.33,
      ivaTarifa: 0,
      ivaDescontable: true,
    });

    expect(linea.subtotal).toBe(500);
  });

  it('el IVA se calcula sobre el subtotal ya redondeado, no sobre cantidad*costo crudo', () => {
    const linea = calcularLineaCompra({
      cantidad: 1,
      costoUnitario: 100.01,
      ivaTarifa: 19,
      ivaDescontable: true,
    });

    expect(linea.subtotal).toBe(100.01);
    expect(linea.ivaValor).toBe(19);
    expect(linea.total).toBe(119.01);
  });
});

describe('calcularLineasCompra', () => {
  it('tarifa mixta en el mismo documento: cada línea liquida la suya, los totales las suman', () => {
    const { lineas, totales } = calcularLineasCompra([
      {
        cantidad: 1,
        costoUnitario: 100000,
        ivaTarifa: 19,
        ivaDescontable: true,
      },
      {
        cantidad: 1,
        costoUnitario: 50000,
        ivaTarifa: 5,
        ivaDescontable: true,
      },
      { cantidad: 1, costoUnitario: 20000, ivaTarifa: 0, ivaDescontable: true },
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
    const { lineas, totales } = calcularLineasCompra([]);

    expect(lineas).toEqual([]);
    expect(totales).toEqual({ subtotal: 0, totalIva: 0, total: 0 });
  });

  it('los totales se acumulan en centavos, no arrastran el redondeo de cada línea', () => {
    const { totales } = calcularLineasCompra([
      { cantidad: 1, costoUnitario: 0.33, ivaTarifa: 19, ivaDescontable: true },
      { cantidad: 1, costoUnitario: 0.33, ivaTarifa: 19, ivaDescontable: true },
      { cantidad: 1, costoUnitario: 0.33, ivaTarifa: 19, ivaDescontable: true },
    ]);

    expect(totales.subtotal).toBe(0.99);
    expect(totales.totalIva).toBe(0.18);
    expect(totales.total).toBe(1.17);
  });
});

describe('totalRetenciones', () => {
  it('suma lo retenido por concepto', () => {
    expect(totalRetenciones([{ valor: 25000 }, { valor: 5000 }])).toBe(30000);
  });

  it('sin retenciones da cero', () => {
    expect(totalRetenciones([])).toBe(0);
  });
});

describe('netoAPagar', () => {
  it('el total menos lo retenido', () => {
    expect(netoAPagar(119000, 25000)).toBe(94000);
  });

  it('sin retenciones, el neto es el total completo', () => {
    expect(netoAPagar(119000, 0)).toBe(119000);
  });
});

describe('calcularPago', () => {
  it('un pago parcial deja el monto pagado corrido, sin tocar el resto', () => {
    const resultado = calcularPago(94000, 0, 40000);

    expect(resultado).toEqual({ ok: true, montoPagado: 40000 });
  });

  it('el segundo pago se suma al primero', () => {
    const resultado = calcularPago(94000, 40000, 54000);

    expect(resultado).toEqual({ ok: true, montoPagado: 94000 });
  });

  it('pagar exactamente el saldo pendiente deja la compra saldada', () => {
    const resultado = calcularPago(94000, 94000 - 10000, 10000);

    expect(resultado).toEqual({ ok: true, montoPagado: 94000 });
  });

  it('rechaza un pago que deje el monto pagado por encima del neto a pagar', () => {
    const resultado = calcularPago(94000, 80000, 20000);

    expect(resultado).toEqual({
      ok: false,
      motivo:
        'Solo faltan 14000 por pagar de esta compra; no se puede pagar 20000.',
    });
  });

  it('rechaza pagar una compra ya saldada', () => {
    const resultado = calcularPago(94000, 94000, 1);

    expect(resultado.ok).toBe(false);
  });

  it('pagada entera y con nota crédito del proveedor después: saldo a favor nuestro', () => {
    const resultado = calcularPago(80000, 94000, 1000);

    expect(resultado).toEqual({
      ok: false,
      motivo:
        'Esta compra tiene 14000 a favor nuestro; eso lo devuelve el proveedor, no se le paga.',
    });
  });
});
