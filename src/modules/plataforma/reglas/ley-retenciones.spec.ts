import { diaAnterior, planearVigencia } from './ley-retenciones';

describe('ley de retenciones — una vigencia nueva', () => {
  it('cierra la abierta el día antes de que empiece la nueva', () => {
    const plan = planearVigencia(
      [{ id: 'a', desde: '2025-06-01', hasta: null }],
      {
        desde: '2026-07-01',
        hasta: null,
      },
    );
    expect(plan).toEqual({
      ok: true,
      cerrar: { id: 'a', hasta: '2026-06-30' },
    });
  });

  it('nunca reescribe: una vigencia que empieza el mismo día o después se rechaza', () => {
    const existentes = [{ id: 'a', desde: '2026-07-01', hasta: null }];
    expect(
      planearVigencia(existentes, { desde: '2026-07-01', hasta: null }).ok,
    ).toBe(false);
    expect(
      planearVigencia(existentes, { desde: '2026-05-08', hasta: '2026-06-30' })
        .ok,
    ).toBe(false);
  });

  it('una suspensión con fecha de fin se puede cargar si no se cruza', () => {
    const existentes = [{ id: 'a', desde: '2025-06-01', hasta: '2026-05-07' }];
    expect(
      planearVigencia(existentes, { desde: '2026-05-08', hasta: '2026-06-30' }),
    ).toEqual({
      ok: true,
      cerrar: null,
    });
    expect(
      planearVigencia(existentes, { desde: '2026-05-01', hasta: null }).ok,
    ).toBe(false);
  });

  it('«hasta» antes de «desde» no tiene sentido', () => {
    expect(
      planearVigencia([], { desde: '2026-07-01', hasta: '2026-06-01' }).ok,
    ).toBe(false);
  });

  it('el día anterior cruza meses y años', () => {
    expect(diaAnterior('2026-03-01')).toBe('2026-02-28');
    expect(diaAnterior('2027-01-01')).toBe('2026-12-31');
  });
});
