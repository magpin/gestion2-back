import {
  diasVencidos,
  edadDe,
  numeroRecibo,
  validarRecibo,
  venceEfectivo,
} from './cartera.reglas';

describe('cartera.reglas', () => {
  it('sin vencimiento pactado, vence a los 30 días', () => {
    expect(venceEfectivo('2026-09-01', null)).toBe('2026-10-01');
    expect(venceEfectivo('2026-09-01', '2026-09-15')).toBe('2026-09-15');
  });

  it('días vencidos contra la fecha pactada', () => {
    expect(diasVencidos('2026-07-01', '2026-07-25', '2026-09-28')).toBe(65);
    expect(diasVencidos('2026-09-20', '2026-10-02', '2026-09-28')).toBe(-4);
  });

  it('las edades, con los bordes del reporte de antigüedad', () => {
    expect(edadDe(-4)).toBe('POR_VENCER');
    expect(edadDe(0)).toBe('POR_VENCER');
    expect(edadDe(1)).toBe('D1_30');
    expect(edadDe(30)).toBe('D1_30');
    expect(edadDe(31)).toBe('D31_60');
    expect(edadDe(90)).toBe('D61_90');
    expect(edadDe(91)).toBe('D90_MAS');
  });

  it('el número del recibo', () => {
    expect(numeroRecibo(128)).toBe('RC-000128');
  });

  describe('validarRecibo', () => {
    it('suma el dinero al centavo: abonos más anticipo, menos la comisión', () => {
      expect(
        validarRecibo(
          [
            { facturaId: 'a', valor: 1_980_000 },
            { facturaId: 'b', valor: 820_000.1, descuento: 16_400 },
          ],
          200_000,
          25_000,
        ),
      ).toEqual({ ok: true, total: 3_000_000.1, neto: 2_975_000.1 });
    });

    it('un anticipo solo, sin facturas, es un recibo', () => {
      expect(validarRecibo([], 500_000)).toEqual({
        ok: true,
        total: 500_000,
        neto: 500_000,
      });
    });

    it('rechaza vacío, repetidas, renglones sin nada y comisión que se lo lleva todo', () => {
      expect(validarRecibo([]).ok).toBe(false);
      expect(
        validarRecibo([
          { facturaId: 'a', valor: 1 },
          { facturaId: 'a', valor: 2 },
        ]).ok,
      ).toBe(false);
      expect(validarRecibo([{ facturaId: 'a', valor: 0 }]).ok).toBe(false);
      expect(
        validarRecibo([{ facturaId: 'a', valor: 0, descuento: 100 }]).ok,
      ).toBe(false);
      expect(validarRecibo([{ facturaId: 'a', valor: 100 }], 0, 100).ok).toBe(
        false,
      );
    });
  });
});
