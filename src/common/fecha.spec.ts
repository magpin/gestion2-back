import { fechaEnLetras } from './fecha';

describe('fechaEnLetras', () => {
  it('escribe el día, el mes en español y el año', () => {
    expect(fechaEnLetras('2026-09-28')).toBe('28 de septiembre de 2026');
    expect(fechaEnLetras('2026-01-01')).toBe('1 de enero de 2026');
    expect(fechaEnLetras('2026-12-31')).toBe('31 de diciembre de 2026');
  });

  it('no corre el día aunque venga con hora (se lee del texto, sin zona)', () => {
    expect(fechaEnLetras('2026-09-28T00:00:00.000Z')).toBe(
      '28 de septiembre de 2026',
    );
  });

  it('devuelve tal cual lo que no es una fecha', () => {
    expect(fechaEnLetras('')).toBe('');
    expect(fechaEnLetras('mañana')).toBe('mañana');
    expect(fechaEnLetras('2026-13-01')).toBe('2026-13-01');
  });
});
