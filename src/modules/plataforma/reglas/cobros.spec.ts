import {
  decidirMora,
  estadoDeCuenta,
  periodosACobrar,
  proximoCorte,
  type Cargo,
} from './cobros';

const cargo = (periodo: string, monto: number, venceEn: string): Cargo => ({
  id: periodo,
  periodo,
  plan: 'BASICO',
  monto,
  venceEn,
});

describe('periodosACobrar', () => {
  it('cobra cada mes cuyo corte ya pasó, desde que se empezó a cobrar', () => {
    expect(periodosACobrar('2026-07-10', 10, '2026-09-22')).toEqual([
      { periodo: '2026-07', venceEn: '2026-07-10' },
      { periodo: '2026-08', venceEn: '2026-08-10' },
      { periodo: '2026-09', venceEn: '2026-09-10' },
    ]);
  });

  it('si empezó después del corte, el primer cobro es el mes siguiente', () => {
    expect(periodosACobrar('2026-09-20', 5, '2026-10-06')).toEqual([
      { periodo: '2026-10', venceEn: '2026-10-05' },
    ]);
  });

  it('el día del corte ya se cobra, y antes no', () => {
    expect(periodosACobrar('2026-09-22', 22, '2026-09-22')).toHaveLength(1);
    expect(periodosACobrar('2026-09-22', 22, '2026-09-21')).toEqual([]);
  });

  it('el próximo corte es después de hoy', () => {
    expect(proximoCorte(1, '2026-09-22', '2026-01-01')).toBe('2026-10-01');
    expect(proximoCorte(25, '2026-09-22', '2026-01-01')).toBe('2026-09-25');
    expect(proximoCorte(22, '2026-09-22', '2026-09-22')).toBe('2026-10-22');
  });
});

describe('estadoDeCuenta', () => {
  const cargos = [
    cargo('2026-07', 100_000, '2026-07-01'),
    cargo('2026-08', 100_000, '2026-08-01'),
    cargo('2026-09', 100_000, '2026-09-01'),
  ];

  it('los pagos cubren del más viejo al más nuevo', () => {
    const e = estadoDeCuenta(
      cargos,
      [{ id: 'p', fecha: '2026-08-15', monto: 150_000 }],
      '2026-09-10',
    );
    const porPeriodo = Object.fromEntries(
      e.cargos.map((c) => [c.periodo, c.estado]),
    );
    expect(porPeriodo).toEqual({
      '2026-07': 'PAGADO',
      '2026-08': 'PARCIAL',
      '2026-09': 'VENCIDO',
    });
    expect(e.saldo).toBe(150_000);
    expect(e.vencido).toBe(150_000);
    // La mora se cuenta desde el vencimiento más viejo sin pagar: agosto.
    expect(e.diasMora).toBe(40);
  });

  it('al día no hay mora, y lo que no ha vencido es pendiente', () => {
    const e = estadoDeCuenta(
      [cargo('2026-09', 100_000, '2026-09-22')],
      [],
      '2026-09-22',
    );
    expect(e.cargos[0].estado).toBe('PENDIENTE');
    expect(e.diasMora).toBe(0);
    expect(e.vencido).toBe(0);
  });

  it('pagar de más deja saldo a favor', () => {
    const e = estadoDeCuenta(
      [cargo('2026-09', 100_000, '2026-09-01')],
      [{ id: 'p', fecha: '2026-09-01', monto: 120_000 }],
      '2026-09-10',
    );
    expect(e.saldo).toBe(-20_000);
    expect(e.diasMora).toBe(0);
  });
});

describe('decidirMora', () => {
  it('a los 15 días sin pagar pasa a morosa, no antes', () => {
    expect(decidirMora('ACTIVO', 15, false)).toBe('MOROSO');
    expect(decidirMora('ACTIVO', 14, false)).toBeNull();
  });

  it('al ponerse al día vuelve a activa solo si la puso morosa el sistema', () => {
    expect(decidirMora('MOROSO', 0, true)).toBe('ACTIVO');
    expect(decidirMora('MOROSO', 0, false)).toBeNull();
    expect(decidirMora('MOROSO', 3, true)).toBeNull();
  });

  it('una suspendida o cancelada no se toca', () => {
    expect(decidirMora('SUSPENDIDO', 90, true)).toBeNull();
    expect(decidirMora('CANCELADO', 90, true)).toBeNull();
  });
});
