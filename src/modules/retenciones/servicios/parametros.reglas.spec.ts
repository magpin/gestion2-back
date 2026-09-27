import {
  elegirTarifa,
  type FotoParametros,
  type TarifaLey,
} from './parametros.reglas';

const t = (x: Partial<TarifaLey>): TarifaLey => ({
  id: 'x',
  conceptoId: 'COMPRAS',
  tipoPersona: null,
  declarante: null,
  baseUvt: 10,
  tarifa: 0.025,
  vigenciaDesde: '2026-07-01',
  vigenciaHasta: null,
  norma: 'Decreto 572/2025',
  ...x,
});

// Compras generales, declarante, con sus cuatro vigencias (especificación §4.3).
const COMPRAS: TarifaLey[] = [
  t({
    id: 'a',
    declarante: true,
    baseUvt: 27,
    vigenciaDesde: '2016-10-11',
    vigenciaHasta: '2025-05-31',
  }),
  t({
    id: 'b',
    declarante: true,
    baseUvt: 10,
    vigenciaDesde: '2025-06-01',
    vigenciaHasta: '2026-05-07',
  }),
  t({
    id: 'c',
    declarante: true,
    baseUvt: 27,
    vigenciaDesde: '2026-05-08',
    vigenciaHasta: '2026-06-30',
  }),
  t({ id: 'd', declarante: true, baseUvt: 10, vigenciaDesde: '2026-07-01' }),
  t({
    id: 'e',
    declarante: false,
    tarifa: 0.035,
    baseUvt: 10,
    vigenciaDesde: '2026-07-01',
  }),
];

const foto = (fecha: string, tarifas = COMPRAS): FotoParametros => ({
  fecha,
  uvt: 52374,
  tarifas,
});
const JURIDICA_DECLARANTE = {
  tipoPersona: 'JURIDICA' as const,
  declarante: true,
};

describe('elegirTarifa — la tarifa de la ley a la fecha del documento', () => {
  it('el 15-jun-2026 rige la suspensión: 27 UVT', () => {
    expect(
      elegirTarifa(foto('2026-06-15'), 'COMPRAS', JURIDICA_DECLARANTE)?.baseUvt,
    ).toBe(27);
  });

  it('el 25-sep-2026 rige el Decreto 572 restablecido: 10 UVT', () => {
    expect(
      elegirTarifa(foto('2026-09-25'), 'COMPRAS', JURIDICA_DECLARANTE)?.id,
    ).toBe('d');
  });

  it('los bordes de la vigencia cuentan: el 30-jun es la suspensión y el 1-jul el restablecimiento', () => {
    expect(
      elegirTarifa(foto('2026-06-30'), 'COMPRAS', JURIDICA_DECLARANTE)?.id,
    ).toBe('c');
    expect(
      elegirTarifa(foto('2026-07-01'), 'COMPRAS', JURIDICA_DECLARANTE)?.id,
    ).toBe('d');
  });

  it('el no declarante toma su propia fila', () => {
    expect(
      elegirTarifa(foto('2026-09-25'), 'COMPRAS', {
        tipoPersona: 'NATURAL',
        declarante: false,
      })?.tarifa,
    ).toBe(0.035);
  });

  it('sin tarifa a esa fecha → null (el motor pregunta, nunca calcula en cero)', () => {
    expect(
      elegirTarifa(foto('2010-01-01'), 'COMPRAS', JURIDICA_DECLARANTE),
    ).toBeNull();
    expect(
      elegirTarifa(foto('2026-09-25'), 'OTRO', JURIDICA_DECLARANTE),
    ).toBeNull();
  });

  it('gana la fila más específica (honorarios: jurídica vs natural declarante/no)', () => {
    const honorarios = [
      t({
        id: 'pj',
        conceptoId: 'HON',
        tipoPersona: 'JURIDICA',
        tarifa: 0.11,
        baseUvt: 0,
      }),
      t({
        id: 'pnd',
        conceptoId: 'HON',
        tipoPersona: 'NATURAL',
        declarante: true,
        tarifa: 0.11,
        baseUvt: 0,
      }),
      t({
        id: 'pnn',
        conceptoId: 'HON',
        tipoPersona: 'NATURAL',
        declarante: false,
        tarifa: 0.1,
        baseUvt: 0,
      }),
    ];
    const f = foto('2026-09-25', honorarios);
    expect(
      elegirTarifa(f, 'HON', { tipoPersona: 'JURIDICA', declarante: false })
        ?.id,
    ).toBe('pj');
    expect(
      elegirTarifa(f, 'HON', { tipoPersona: 'NATURAL', declarante: false })?.id,
    ).toBe('pnn');
    expect(
      elegirTarifa(f, 'HON', { tipoPersona: 'NATURAL', declarante: true })?.id,
    ).toBe('pnd');
  });
});
