import { rangoMes, sugerirConcepto, variacion } from './gastos.reglas';

const conceptos = [
  {
    id: 'flete',
    nombre: 'Transporte, fletes y acarreos',
    pistas: ['flete', 'acarreo'],
  },
  { id: 'papel', nombre: 'Útiles y papelería', pistas: ['papelería', 'resma'] },
  { id: 'ica', nombre: 'Industria y comercio', pistas: ['ica'] },
];

describe('gastos.reglas', () => {
  it('lo que ya se hizo con el tercero manda: dos veces es «la vi clara»', () => {
    const s = sugerirConcepto({
      descripcion: 'resma',
      conceptos,
      historialTercero: ['flete', 'flete', 'papel'],
    });
    expect(s).toMatchObject({ conceptoId: 'flete', certeza: 'CLARA' });
    expect(s.motivo).toMatch(/2 veces/);
  });

  it('una pista en la descripción es «la deduje», sin tildes ni mayúsculas', () => {
    const s = sugerirConcepto({
      descripcion: 'Compra de PAPELERIA',
      conceptos,
      historialTercero: [],
    });
    expect(s).toMatchObject({ conceptoId: 'papel', certeza: 'DEDUCIDA' });
  });

  it('una pista es palabra entera: «publicidad» no es ICA', () => {
    const s = sugerirConcepto({
      descripcion: 'publicidad en radio',
      conceptos,
      historialTercero: [],
    });
    expect(s.certeza).toBe('NO_SE');
  });

  it('dos pistas a la vez no deciden: la persona elige', () => {
    const s = sugerirConcepto({
      descripcion: 'flete de resmas y papelería',
      conceptos,
      historialTercero: [],
    });
    expect(s).toMatchObject({ conceptoId: null, certeza: 'NO_SE' });
    expect(s.motivo).toMatch(/Transporte.* o Útiles/);
  });

  it('un historial que ya no está disponible no cuenta', () => {
    const s = sugerirConcepto({
      descripcion: '',
      conceptos,
      historialTercero: ['borrado', 'borrado'],
    });
    expect(s.certeza).toBe('NO_SE');
  });

  it('el mes y su vecino', () => {
    expect(rangoMes('2026-12')).toEqual({
      desde: '2026-12-01',
      hasta: '2027-01-01',
      anterior: '2026-11',
    });
    expect(rangoMes('2026-01').anterior).toBe('2025-12');
  });

  it('la variación contra el mes anterior', () => {
    expect(variacion(14_732_300, 13_980_100)).toBe(5.4);
    expect(variacion(100, 0)).toBeNull();
  });
});
