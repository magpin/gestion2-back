import { mesSiguiente, quincenaSiguiente } from './pago-programado.service';

describe('Pagos programados: la fecha que sigue', () => {
  it('quincenal: del 15 al último día, y del último al 15 (PC18)', () => {
    expect(quincenaSiguiente('2026-09-15')).toBe('2026-09-30');
    expect(quincenaSiguiente('2026-09-30')).toBe('2026-10-15');
    expect(quincenaSiguiente('2026-02-15')).toBe('2026-02-28');
    expect(quincenaSiguiente('2026-12-31')).toBe('2027-01-15');
    // Un día raro se endereza a la quincena.
    expect(quincenaSiguiente('2026-09-03')).toBe('2026-09-30');
    expect(quincenaSiguiente('2026-09-20')).toBe('2026-10-15');
  });

  it('mensual: el mismo día, o el último si no existe', () => {
    expect(mesSiguiente('2026-01-31')).toBe('2026-02-28');
    expect(mesSiguiente('2026-09-01')).toBe('2026-10-01');
  });
});
