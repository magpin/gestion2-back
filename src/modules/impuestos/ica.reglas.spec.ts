import { alMil, armarIcaPropio } from './ica.reglas';

describe('ICA propio del año', () => {
  it('base por tarifa, más avisos y tableros, menos lo anticipado', () => {
    const r = armarIcaPropio({
      anio: 2026,
      ingresos: 412_345_678,
      excluidos: 12_000_000,
      tarifaPorMil: 5,
      fuenteTarifa: 'LEY',
      avisosTableros: true,
      anticipos: 350_400,
    });
    expect(r.ingresos).toBe(412_346_000);
    expect(r.base).toBe(400_346_000);
    // 400.346.000 × 5 ‰ = 2.001.730 → 2.002.000
    expect(r.impuesto).toBe(2_002_000);
    // 15 % de 2.002.000 = 300.300 → 300.000
    expect(r.avisos).toBe(300_000);
    expect(r.total).toBe(2_302_000);
    expect(r.anticipos).toBe(350_000);
    expect(r.saldo).toBe(1_952_000);
  });

  it('sin avisos no suma el 15 %', () => {
    const r = armarIcaPropio({
      anio: 2026,
      ingresos: 100_000_000,
      excluidos: 0,
      tarifaPorMil: 7,
      fuenteTarifa: 'PROVISIONAL',
      avisosTableros: false,
      anticipos: 0,
    });
    expect(r.avisos).toBe(0);
    expect(r.total).toBe(700_000);
    expect(r.fuenteTarifa).toBe('PROVISIONAL');
  });

  it('lo anticipado puede dejar saldo a favor', () => {
    const r = armarIcaPropio({
      anio: 2026,
      ingresos: 10_000_000,
      excluidos: 0,
      tarifaPorMil: 2,
      fuenteTarifa: 'LEY',
      avisosTableros: false,
      anticipos: 50_000,
    });
    expect(r.saldo).toBe(-30_000);
  });

  it('sin tarifa cargada no calcula: no inventa', () => {
    const r = armarIcaPropio({
      anio: 2026,
      ingresos: 50_000_000,
      excluidos: 60_000_000,
      tarifaPorMil: null,
      fuenteTarifa: null,
      avisosTableros: true,
      anticipos: 0,
    });
    expect(r.base).toBe(0);
    expect(r.impuesto).toBeNull();
    expect(r.saldo).toBeNull();
  });

  it('al mil', () => {
    expect(alMil(1_499)).toBe(1_000);
    expect(alMil(1_500)).toBe(2_000);
  });
});
