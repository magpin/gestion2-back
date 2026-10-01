import {
  armarPago,
  nombrePeriodo,
  periodoDe,
  periodosDelAnio,
  rangoDe,
  situacion,
  ultimoDigito,
} from './impuestos.reglas';

const cuenta = (codigo: string) => ({
  cuentaId: `id-${codigo}`,
  codigo,
  nombre: codigo,
});
/** Una cuenta de retención: va por tercero y pide base. */
const retenida = (codigo: string) => ({
  ...cuenta(codigo),
  terceroId: 'prov',
  exigeBase: true,
});

describe('impuestos', () => {
  it('el último dígito es el del NIT, no el de verificación', () => {
    expect(ultimoDigito('901234567')).toBe(7);
    expect(ultimoDigito('901.234.567')).toBe(7);
  });

  it('los períodos y sus fechas', () => {
    expect(periodoDe('MENSUAL', '2026-09-14')).toBe('2026-09');
    expect(periodoDe('BIMESTRAL', '2026-09-14')).toBe('2026-B5');
    expect(periodoDe('CUATRIMESTRAL', '2026-09-14')).toBe('2026-C3');
    expect(periodoDe('TRIMESTRAL', '2026-09-14')).toBe('2026-T3');
    expect(periodoDe('ANUAL', '2026-09-14')).toBe('2026');
    expect(rangoDe('2026-02')).toEqual({
      desde: '2026-02-01',
      hasta: '2026-02-28',
    });
    expect(rangoDe('2026-C3')).toEqual({
      desde: '2026-09-01',
      hasta: '2026-12-31',
    });
    expect(rangoDe('2026-B5')).toEqual({
      desde: '2026-09-01',
      hasta: '2026-10-31',
    });
    expect(rangoDe('2025')).toEqual({
      desde: '2025-01-01',
      hasta: '2025-12-31',
    });
    expect(periodosDelAnio('CUATRIMESTRAL', 2026)).toEqual([
      '2026-C1',
      '2026-C2',
      '2026-C3',
    ]);
    expect(periodosDelAnio('MENSUAL', 2026)).toHaveLength(12);
    expect(nombrePeriodo('2026-09')).toBe('septiembre');
    expect(nombrePeriodo('2026-C3')).toBe('sep–dic');
    expect(nombrePeriodo('2025')).toBe('2025');
  });

  it('en qué va cada obligación', () => {
    const hoy = '2026-10-14';
    expect(
      situacion({ periodo: '2026-10', hoy, vence: null, declaracion: null })
        .estado,
    ).toBe('CAUSANDOSE');
    expect(
      situacion({
        periodo: '2026-09',
        hoy,
        vence: '2026-10-21',
        declaracion: null,
      }),
    ).toEqual({
      estado: 'POR_PRESENTAR',
      dias: 7,
      vencida: false,
    });
    expect(
      situacion({
        periodo: '2026-09',
        hoy,
        vence: '2026-10-10',
        declaracion: { estado: 'PRESENTADA' },
      }),
    ).toEqual({ estado: 'PRESENTADA', dias: -4, vencida: true });
    expect(
      situacion({
        periodo: '2026-08',
        hoy,
        vence: '2026-09-22',
        declaracion: { estado: 'PAGADA' },
      }).vencida,
    ).toBe(false);
  });

  describe('el pago', () => {
    const base = {
      intereses: 0,
      cuentaIntereses: cuenta('530520'),
      ajusteIngreso: cuenta('429581'),
      ajusteGasto: cuenta('530595'),
    };
    const causado = [
      { ...retenida('236515'), valor: 120_000 },
      { ...retenida('236540'), valor: 460_250 },
      { ...retenida('236575'), valor: 167_400 },
    ];

    it('debita cada cuenta por lo causado y el redondeo va a ajuste al peso', () => {
      const r = armarPago({ ...base, causado, valorAPagar: 747_000 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.redondeo).toBe(-650);
      expect(r.total).toBe(747_000);
      const ajuste = r.partidas.find((p) => p.codigo === '429581');
      expect(ajuste).toMatchObject({ debito: 0, credito: 650 });
      const debitos = r.partidas.reduce((t, p) => t + p.debito - p.credito, 0);
      expect(Math.round(debitos * 100) / 100).toBe(747_000);
    });

    it('los intereses suman a lo que sale y van a su cuenta', () => {
      const r = armarPago({
        ...base,
        causado,
        valorAPagar: 748_000,
        intereses: 12_000,
      });
      expect(r.ok && r.total).toBe(760_000);
      expect(
        r.ok && r.partidas.find((p) => p.codigo === '530520')?.debito,
      ).toBe(12_000);
    });

    it('no paga si el libro no cuadra con la declaración', () => {
      const r = armarPago({ ...base, causado, valorAPagar: 900_000 });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.motivo).toMatch(/más que el redondeo/);
    });

    it('no paga si no hay nada causado', () => {
      expect(armarPago({ ...base, causado: [], valorAPagar: 0 }).ok).toBe(
        false,
      );
    });
  });
});
