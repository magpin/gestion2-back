import {
  causaGmf,
  numeroTraslado,
  problemaDeTraslado,
  tipoEnBanco,
} from './traslado.reglas';

describe('traslado.reglas', () => {
  it('nombra el movimiento del banco según de dónde viene y a dónde va', () => {
    expect(tipoEnBanco('ENTRADA', 'CAJA')).toBe('CONSIGNACION');
    expect(tipoEnBanco('SALIDA', 'CAJA')).toBe('RETIRO');
    expect(tipoEnBanco('ENTRADA', 'BANCO')).toBe('TRANSFERENCIA_ENTRANTE');
    expect(tipoEnBanco('SALIDA', 'BANCO')).toBe('TRANSFERENCIA_SALIENTE');
  });

  it('el 4×1000 solo sale de un banco, y no entre cuentas del mismo banco', () => {
    const caja = { medio: 'CAJA' as const, id: 'c' };
    const bancolombia = {
      medio: 'BANCO' as const,
      id: 'b1',
      banco: 'Bancolombia',
    };
    const otraBancolombia = {
      medio: 'BANCO' as const,
      id: 'b2',
      banco: ' bancolombia ',
    };
    const davivienda = {
      medio: 'BANCO' as const,
      id: 'b3',
      banco: 'Davivienda',
    };
    expect(causaGmf(caja, bancolombia)).toBe(false);
    expect(causaGmf(bancolombia, caja)).toBe(true);
    expect(causaGmf(bancolombia, otraBancolombia)).toBe(false);
    expect(causaGmf(bancolombia, davivienda)).toBe(true);
  });

  it('no deja trasladar a sí mismo', () => {
    const b = { medio: 'BANCO' as const, id: 'b1' };
    expect(problemaDeTraslado(b, b)).toMatch(/mismo/);
    expect(problemaDeTraslado(b, { medio: 'CAJA', id: 'b1' })).toBeNull();
  });

  it('numera TR-000012', () => {
    expect(numeroTraslado(12)).toBe('TR-000012');
  });
});
