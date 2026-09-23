import {
  calcularEntrada,
  calcularReversaDeEntrada,
  calcularSalida,
  redondear,
  type SaldoKardex,
} from './kardex.reglas';

//esta función es para tal cosa.
const CERO: SaldoKardex = { cantidad: 0, costoPromedio: 0 };
const DEC = 2; // decimales_cantidad y decimales_valor, para no repetirlo en cada caso

describe('redondear', () => {
  it('no arrastra el error de punto flotante', () => {
    // 0.1 + 0.2 en punto flotante crudo da 0.30000000000000004, no 0.3.
    expect(redondear(0.1 + 0.2, 1)).toBe(0.3);
  });
});

describe('calcularEntrada', () => {
  it('sobre saldo cero, el costo promedio es el costo de la entrada', () => {
    const r = calcularEntrada(CERO, 100, 1_000, DEC, DEC);

    expect(r.saldo.cantidad).toBe(100);
    expect(r.saldo.costoPromedio).toBe(1_000);
    expect(r.valorMovimiento).toBe(100_000);
  });

  it('sobre saldo existente, pondera por cantidad — números que no cuadran "bonito"', () => {
    // 100 a 1.000 + 20 a 1.200 → (100×1.000 + 20×1.200) / 120 = 1.033,33...
    const actual: SaldoKardex = { cantidad: 100, costoPromedio: 1_000 };
    const r = calcularEntrada(actual, 20, 1_200, DEC, DEC);

    expect(r.saldo.cantidad).toBe(120);
    expect(r.saldo.costoPromedio).toBe(1_033.33);
    expect(r.valorMovimiento).toBe(24_000);
  });

  it('redondea el costo promedio a los decimales de la empresa', () => {
    const actual: SaldoKardex = { cantidad: 3, costoPromedio: 10 };
    // (3×10 + 1×1) / 4 = 7.75 exacto — con 0 decimales debe redondear a 8.
    const r = calcularEntrada(actual, 1, 1, 0, 0);

    expect(r.saldo.costoPromedio).toBe(8);
  });

  it('el valor del movimiento siempre redondea a 2 decimales, aunque el costo tenga más', () => {
    // Costo con 4 decimales (empresa que compra al por mayor): el total sigue en pesos con centavos.
    const r = calcularEntrada(CERO, 3, 0.3333, DEC, 4);

    expect(r.saldo.costoPromedio).toBe(0.3333);
    expect(r.valorMovimiento).toBe(1); // 3 × 0.3333 = 0.9999 → $1
  });
});

describe('calcularSalida', () => {
  it('no mueve el costo promedio, solo la cantidad', () => {
    const actual: SaldoKardex = { cantidad: 100, costoPromedio: 1_033.33 };
    const r = calcularSalida(actual, 30, DEC);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo.cantidad).toBe(70);
    expect(r.saldo.costoPromedio).toBe(1_033.33);
    expect(r.valorMovimiento).toBe(30_999.9);
  });

  it('deja la cantidad exacta en cero sin rechazar', () => {
    const actual: SaldoKardex = { cantidad: 50, costoPromedio: 200 };
    const r = calcularSalida(actual, 50, DEC);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo.cantidad).toBe(0);
    expect(r.saldo.costoPromedio).toBe(200);
  });

  it('se rechaza si deja la existencia negativa, con el motivo exacto', () => {
    const actual: SaldoKardex = { cantidad: 45, costoPromedio: 500 };
    const r = calcularSalida(actual, 60, DEC);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('Solo hay 45 en existencia; no se puede sacar 60.');
  });

  it('con el descubierto permitido, sale igual y dice cuántas unidades faltaron', () => {
    const actual: SaldoKardex = { cantidad: 45, costoPromedio: 500 };
    const r = calcularSalida(actual, 60, DEC, true);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo.cantidad).toBe(-15);
    // El promedio no cambia: una salida consume, no valora.
    expect(r.saldo.costoPromedio).toBe(500);
    // Las 60 unidades se valoran al promedio conocido, no solo las 45.
    expect(r.valorMovimiento).toBe(30_000);
    expect(r.faltante).toBe(15);
  });

  it('el faltante es cero cuando había existencia, aunque el descubierto esté permitido', () => {
    const actual: SaldoKardex = { cantidad: 45, costoPromedio: 500 };
    const r = calcularSalida(actual, 45, DEC, true);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.faltante).toBe(0);
  });
});

describe('calcularReversaDeEntrada — deshacer una compra al costo con que entró', () => {
  // Había 10 a 1.000; entraron 10 a 2.000 (promedio 1.500). Anular esa compra
  // tiene que dejar exactamente lo que había: 10 a 1.000.
  it('vuelve al saldo de antes de la entrada, no al promedio', () => {
    const r = calcularReversaDeEntrada(
      { cantidad: 20, costoPromedio: 1_500 },
      10,
      2_000,
      6,
      6,
    );
    expect(r).toEqual({
      ok: true,
      saldo: { cantidad: 10, costoPromedio: 1_000 },
      valorMovimiento: 20_000,
      faltante: 0,
    });
  });

  it('al promedio habría salido 15.000, y la cuenta dice 20.000', () => {
    const alPromedio = calcularSalida({ cantidad: 20, costoPromedio: 1_500 }, 10, 6);
    const exacta = calcularReversaDeEntrada({ cantidad: 20, costoPromedio: 1_500 }, 10, 2_000, 6, 6);
    expect(alPromedio.ok && exacta.ok && exacta.valorMovimiento - alPromedio.valorMovimiento).toBe(5_000);
  });

  it('si no queda nada, conserva el promedio', () => {
    const r = calcularReversaDeEntrada({ cantidad: 10, costoPromedio: 2_000 }, 10, 2_000, 6, 6);
    expect(r.ok && r.saldo).toEqual({ cantidad: 0, costoPromedio: 2_000 });
  });

  it('si parte ya salió, no se puede', () => {
    const r = calcularReversaDeEntrada({ cantidad: 3, costoPromedio: 2_000 }, 10, 2_000, 6, 6);
    expect(r.ok).toBe(false);
  });
});
