import { redondearDecimal } from './decimal';

describe('redondearDecimal', () => {
  it('redondea la mitad hacia arriba como Postgres, aunque el binario quede abajo', () => {
    // Los dos casos reales de la carga de QA (2 oct 2026).
    expect(redondearDecimal(10 * 31218.3475, 2)).toBe(312183.48);
    expect(redondearDecimal(10 * 57913.3175, 2)).toBe(579133.18);
    expect(redondearDecimal(1.005, 2)).toBe(1.01);
  });

  it('la mitad negativa se aleja del cero', () => {
    expect(redondearDecimal(-1.005, 2)).toBe(-1.01);
    expect(redondearDecimal(-0.004, 2)).toBe(0);
  });

  it('deja igual lo que ya está redondeado y respeta otros decimales', () => {
    expect(redondearDecimal(100000, 2)).toBe(100000);
    expect(redondearDecimal(0.1 + 0.2, 2)).toBe(0.3);
    expect(redondearDecimal(3 * 0.3333, 2)).toBe(1);
    expect(redondearDecimal(46.0000005, 6)).toBe(46.000001);
    expect(redondearDecimal(1234.5, 0)).toBe(1235);
  });

  it('números muy chicos o muy grandes no rompen el texto', () => {
    expect(redondearDecimal(1e-7, 6)).toBe(0);
    expect(redondearDecimal(5e-7, 6)).toBe(0.000001);
    expect(redondearDecimal(1e20, 2)).toBe(1e20);
  });
});
