import { venceDesdePlazo } from './plazo';

describe('Vence desde el plazo del tercero (PC25)', () => {
  it('la fecha más los días', () => {
    expect(venceDesdePlazo('2026-09-28', 30)).toBe('2026-10-28');
    expect(venceDesdePlazo('2026-12-15', 30)).toBe('2027-01-14');
    expect(venceDesdePlazo('2026-09-28', 0)).toBe('2026-09-28');
  });

  it('sin plazo no inventa', () => {
    expect(venceDesdePlazo('2026-09-28', null)).toBeNull();
    expect(venceDesdePlazo('2026-09-28', undefined)).toBeNull();
  });
});
