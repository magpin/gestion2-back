import { OID_DATE, OID_DATE_ARRAY, fechasComoTexto } from './tipos-pg';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { types } = require('pg') as {
  types: { getTypeParser(oid: number): (valor: string) => unknown };
};

describe('tipos de pg', () => {
  beforeAll(() => fechasComoTexto());

  it('una columna date llega como el texto AAAA-MM-DD, no como Date', () => {
    const valor = types.getTypeParser(OID_DATE)('2026-09-28');
    expect(valor).toBe('2026-09-28');
  });

  it('un arreglo de date llega como arreglo de textos', () => {
    const valor = types.getTypeParser(OID_DATE_ARRAY)(
      '{2026-09-28,2026-10-01}',
    );
    expect(valor).toEqual(['2026-09-28', '2026-10-01']);
  });

  it('timestamptz sigue siendo un instante (Date)', () => {
    const valor = types.getTypeParser(1184)('2026-09-28 02:00:00+00');
    expect(valor).toBeInstanceOf(Date);
  });
});
