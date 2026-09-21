import {
  decidir,
  hayHistoria,
  HISTORIA_MINIMA,
  type ReglaVigente,
} from './autonomia';

const regla = (e: Partial<ReglaVigente> = {}): ReglaVigente => ({
  id: 'r-1',
  accion: 'COBRO',
  modo: 'CONFIRMAR_SI_PASA',
  limite: 2_000_000,
  activadaPor: 'u-director',
  ...e,
});

const base = {
  accion: 'COBRO' as const,
  total: 1_000_000,
  pausada: false,
  regla: regla(),
  rolesDelActivador: ['DIRECTOR'] as const,
  duplicadoPosible: false,
};

describe('decidir — si una propuesta se confirma sola', () => {
  it('bajo el límite, con quien activó la regla pudiendo registrar y sin duplicado: sí', () => {
    expect(decidir(base)).toEqual({ confirmar: true, regla: regla() });
  });

  it('justo en el límite, sí; un peso arriba, espera y dice por qué', () => {
    expect(decidir({ ...base, total: 2_000_000 }).confirmar).toBe(true);
    const arriba = decidir({ ...base, total: 2_000_001 });
    expect(arriba.confirmar).toBe(false);
    expect(!arriba.confirmar && arriba.motivo).toMatch(
      /supera el límite de \$ 2\.000\.000/,
    );
  });

  it('pausada, sin regla o en solo proponer: espera, sin motivo que decir', () => {
    expect(decidir({ ...base, pausada: true })).toEqual({
      confirmar: false,
      motivo: null,
    });
    expect(decidir({ ...base, regla: null })).toEqual({
      confirmar: false,
      motivo: null,
    });
    expect(
      decidir({
        ...base,
        regla: regla({ modo: 'SOLO_PROPONER', limite: null }),
      }),
    ).toEqual({ confirmar: false, motivo: null });
  });

  it('si quien activó la regla ya no puede cobrar, espera', () => {
    const r = decidir({ ...base, rolesDelActivador: ['CONTADOR'] });
    expect(r.confirmar).toBe(false);
    expect(!r.confirmar && r.motivo).toMatch(/ya no puede registrar/);
  });

  it('una persona desactivada no tiene roles: su regla no actúa', () => {
    expect(decidir({ ...base, rolesDelActivador: [] }).confirmar).toBe(false);
  });

  it('un posible duplicado espera', () => {
    const r = decidir({ ...base, duplicadoPosible: true });
    expect(!r.confirmar && r.motivo).toMatch(/duplicado/);
  });
});

describe('hayHistoria', () => {
  it(`hacen falta ${HISTORIA_MINIMA} confirmadas por una persona; las automáticas no cuentan`, () => {
    expect(
      hayHistoria({
        confirmadas: HISTORIA_MINIMA - 1,
        sinCorregir: 19,
        automaticas: 50,
      }),
    ).toBe(false);
    expect(
      hayHistoria({
        confirmadas: HISTORIA_MINIMA,
        sinCorregir: 0,
        automaticas: 0,
      }),
    ).toBe(true);
  });
});
