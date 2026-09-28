import {
  avisoPagoExterior,
  SUBCUENTA_IVA_RETENIDO,
  subcuentaIvaPorCrear,
  subcuentasPorCrear,
} from './exterior.reglas';

describe('Pagos al exterior', () => {
  describe('subcuentasPorCrear (bug #10)', () => {
    it('la empresa agente sin la 236550 la crea para el concepto del exterior', () => {
      expect(
        subcuentasPorCrear(
          [{ cuentaId: null, subcuentaPasivo: '236550' }],
          true,
        ),
      ).toEqual(['236550']);
    });

    it('una sola vez aunque varias retenciones la pidan', () => {
      expect(
        subcuentasPorCrear(
          [
            { cuentaId: null, subcuentaPasivo: '236550' },
            { cuentaId: null, subcuentaPasivo: '236550' },
            { cuentaId: 'c1', subcuentaPasivo: '236525' },
          ],
          true,
        ),
      ).toEqual(['236550']);
    });

    it('la que ya tiene cuenta no se crea', () => {
      expect(
        subcuentasPorCrear(
          [{ cuentaId: 'c1', subcuentaPasivo: '236550' }],
          true,
        ),
      ).toEqual([]);
    });

    it('quien no es agente de renta no crea nada', () => {
      expect(
        subcuentasPorCrear(
          [{ cuentaId: null, subcuentaPasivo: '236550' }],
          false,
        ),
      ).toEqual([]);
    });

    it('solo subcuentas de seis dígitos de la 2365', () => {
      expect(
        subcuentasPorCrear(
          [
            { cuentaId: null, subcuentaPasivo: '2367' },
            { cuentaId: null, subcuentaPasivo: null },
          ],
          true,
        ),
      ).toEqual([]);
    });
  });

  describe('avisoPagoExterior (bug #10)', () => {
    it('con convenio disponible manda al botón, no al contador', () => {
      const aviso = avisoPagoExterior(true);
      expect(aviso).toContain('aplicá el convenio');
      expect(aviso).not.toContain('contador');
    });

    it('sin convenio dice dónde cargar el certificado', () => {
      const aviso = avisoPagoExterior(false);
      expect(aviso).toContain('certificado de residencia fiscal');
      expect(aviso).not.toContain('contador');
    });
  });
});

describe('subcuentaIvaPorCrear (bug #17)', () => {
  it('una ReteIVA sin cuenta pide la 236705, la misma del plan sugerido', () => {
    expect(SUBCUENTA_IVA_RETENIDO).toBe('236705');
    expect(subcuentaIvaPorCrear([{ cuentaId: null }])).toBe('236705');
  });

  it('el IVA del exterior asumido sin cuenta también (art. 437-2 num. 3)', () => {
    expect(subcuentaIvaPorCrear([{ cuentaId: 'c1' }, { cuentaId: null }])).toBe(
      '236705',
    );
  });

  it('con la cuenta enlazada no se crea nada', () => {
    expect(subcuentaIvaPorCrear([{ cuentaId: 'c1' }])).toBeNull();
  });

  it('sin ReteIVA no se crea nada: la 2367 no va por defecto', () => {
    expect(subcuentaIvaPorCrear([])).toBeNull();
  });
});
