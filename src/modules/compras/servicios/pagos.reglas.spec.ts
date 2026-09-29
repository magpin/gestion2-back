import {
  descuentoSugerido,
  numeroComprobante,
  tramoDe,
  validarComprobante,
  venceEfectivo,
} from './pagos.reglas';

describe('pagos.reglas', () => {
  it('sin vencimiento pactado, vence a los 30 días', () => {
    expect(venceEfectivo('2026-09-01', null)).toBe('2026-10-01');
  });

  // Lunes 28 de septiembre de 2026.
  const hoy = '2026-09-28';
  it('los tramos de la semana, desde el lunes', () => {
    expect(tramoDe('2026-09-20', hoy)).toBe('VENCIDO');
    expect(tramoDe('2026-09-28', hoy)).toBe('ESTA_SEMANA');
    expect(tramoDe('2026-10-04', hoy)).toBe('ESTA_SEMANA'); // domingo
    expect(tramoDe('2026-10-05', hoy)).toBe('PROXIMA_SEMANA');
    expect(tramoDe('2026-10-11', hoy)).toBe('PROXIMA_SEMANA');
    // La próxima semana ya entra a octubre: el tramo va hasta fin de octubre.
    expect(tramoDe('2026-10-31', hoy)).toBe('RESTO_MES');
    expect(tramoDe('2026-11-02', hoy)).toBe('DESPUES');
  });

  it('el número del comprobante', () => {
    expect(numeroComprobante(77)).toBe('EG-000077');
  });

  it('el descuento por pronto pago, solo en plazo', () => {
    expect(descuentoSugerido(1_070_000, 2, '2026-09-30', '2026-09-28')).toBe(
      21_400,
    );
    expect(descuentoSugerido(1_070_000, 2, '2026-09-30', '2026-10-01')).toBe(0);
    expect(descuentoSugerido(1_070_000, null, null, '2026-09-28')).toBe(0);
  });

  it('valida lo que no necesita la base', () => {
    expect(validarComprobante([{ compraId: 'a', valor: 100 }]).ok).toBe(true);
    expect(validarComprobante([], 500).ok).toBe(true);
    expect(validarComprobante([]).ok).toBe(false);
    expect(
      validarComprobante([
        { compraId: 'a', valor: 1 },
        { compraId: 'a', valor: 1 },
      ]).ok,
    ).toBe(false);
    expect(
      validarComprobante([{ compraId: 'a', valor: 0, descuento: 10 }]).ok,
    ).toBe(false);
  });
});
