import {
  calcularDiferenciaArqueo,
  calcularEgreso,
  calcularIngreso,
  redondear,
  verificarPuedeAbrirArqueo,
} from './caja.reglas';

describe('redondear', () => {
  it('no arrastra el error de punto flotante', () => {
    // 0.1 + 0.2 en punto flotante crudo da 0.30000000000000004, no 0.3.
    expect(redondear(0.1 + 0.2, 1)).toBe(0.3);
  });

  it('redondea a 2 decimales por omisión', () => {
    expect(redondear(100.005)).toBe(100.01);
  });
});

describe('calcularIngreso', () => {
  it('suma sobre saldo cero', () => {
    expect(calcularIngreso(0, 50_000)).toBe(50_000);
  });

  it('suma sobre saldo existente', () => {
    expect(calcularIngreso(120_000, 30_500)).toBe(150_500);
  });
});

describe('calcularEgreso', () => {
  it('resta cuando el saldo alcanza', () => {
    const r = calcularEgreso(100_000, 40_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo).toBe(60_000);
  });

  it('deja el saldo exacto en cero sin rechazar', () => {
    const r = calcularEgreso(50_000, 50_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saldo).toBe(0);
  });

  it('se rechaza si deja la caja en negativo, con el motivo exacto', () => {
    const r = calcularEgreso(45_000, 60_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('Solo hay 45000 en caja; no se puede sacar 60000.');
  });
});

describe('calcularDiferenciaArqueo', () => {
  it('es cero cuando lo contado coincide con el sistema', () => {
    expect(calcularDiferenciaArqueo(100_000, 100_000)).toBe(0);
  });

  it('es positiva cuando sobra plata', () => {
    expect(calcularDiferenciaArqueo(100_000, 105_000)).toBe(5_000);
  });

  it('es negativa cuando falta plata', () => {
    expect(calcularDiferenciaArqueo(100_000, 92_000)).toBe(-8_000);
  });
});

describe('verificarPuedeAbrirArqueo', () => {
  it('permite abrir si no hay uno abierto', () => {
    expect(verificarPuedeAbrirArqueo(false)).toEqual({ ok: true });
  });

  it('rechaza con el motivo exacto si ya hay uno abierto', () => {
    expect(verificarPuedeAbrirArqueo(true)).toEqual({
      ok: false,
      motivo:
        'Ya hay un arqueo abierto para esta caja. Cerralo antes de abrir uno nuevo.',
    });
  });
});
