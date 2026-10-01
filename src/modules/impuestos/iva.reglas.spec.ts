import { armarIva, mesesDe, periodoAnterior } from './iva.reglas';

describe('IVA del período', () => {
  it('los meses y el período anterior', () => {
    expect(mesesDe('2026-C3')).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(mesesDe('2026-B6')).toEqual(['2026-11', '2026-12']);
    expect(periodoAnterior('2026-C3')).toBe('2026-C2');
    expect(periodoAnterior('2026-C1')).toBe('2025-C3');
    expect(periodoAnterior('2026-B1')).toBe('2025-B6');
  });

  it('generado menos descontable menos lo que le retuvieron', () => {
    const r = armarIva({
      periodo: '2026-C3',
      ventas: [
        { mes: '2026-09', tarifa: 19, base: 20_000_000, iva: 3_800_000 },
        { mes: '2026-10', tarifa: 19, base: 16_000_000, iva: 3_040_000 },
        // Una nota crédito resta.
        { mes: '2026-10', tarifa: 19, base: -150_000, iva: -28_500 },
        { mes: '2026-10', tarifa: 5, base: 1_000_000, iva: 50_000 },
        { mes: '2026-09', tarifa: 0, base: 800_000, iva: 0 },
      ],
      compras: [
        {
          mes: '2026-09',
          tarifa: 19,
          base: 12_000_000,
          iva: 2_280_000,
          descontable: true,
        },
        {
          mes: '2026-10',
          tarifa: 19,
          base: 11_000_000,
          iva: 2_090_000,
          descontable: true,
        },
        // IVA que no se descuenta: no resta.
        {
          mes: '2026-10',
          tarifa: 19,
          base: 300_000,
          iva: 57_000,
          descontable: false,
        },
      ],
      reteIvaSufrida: 120_000,
      libro2408: 2_491_500,
    });
    expect(r.generado.porTarifa).toEqual([
      { tarifa: 19, base: 35_850_000, iva: 6_811_500 },
      { tarifa: 5, base: 1_000_000, iva: 50_000 },
    ]);
    expect(r.generado.total).toBe(6_861_500);
    expect(r.ventasTarifaCero).toBe(800_000);
    expect(r.descontable.total).toBe(4_370_000);
    expect(r.noDescontable).toBe(57_000);
    expect(r.saldo).toBe(6_861_500 - 4_370_000 - 120_000);
    expect(r.cuadre).toEqual({
      libro: 2_491_500,
      documentos: 2_491_500,
      diferencia: 0,
      cuadra: true,
    });
    expect(r.mesAMes).toHaveLength(4);
    expect(r.mesAMes[0]).toEqual({
      mes: '2026-09',
      generado: 3_800_000,
      descontable: 2_280_000,
    });
    expect(r.mesAMes[3]).toEqual({
      mes: '2026-12',
      generado: 0,
      descontable: 0,
    });
  });

  it('avisa si el libro no cuadra con los documentos', () => {
    const r = armarIva({
      periodo: '2026-B5',
      ventas: [{ mes: '2026-09', tarifa: 19, base: 1_000_000, iva: 190_000 }],
      compras: [],
      reteIvaSufrida: 0,
      libro2408: 150_000,
    });
    expect(r.cuadre.cuadra).toBe(false);
    expect(r.cuadre.diferencia).toBe(-40_000);
  });
});
