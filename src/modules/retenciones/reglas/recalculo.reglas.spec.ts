import {
  compararRecalculo,
  type RetencionNueva,
  type RetencionVivaClave,
} from './recalculo.reglas';

const viva = (p: Partial<RetencionVivaClave>): RetencionVivaClave => ({
  retencionId: 'rc-1',
  impuesto: 'RENTA',
  conceptoCodigo: 'COMPRAS_GENERALES',
  conceptoId: 'n-compras',
  municipio: null,
  base: 1_000_000,
  valor: 25_000,
  tarifa: 0.025,
  ...p,
});

const nueva = (p: Partial<RetencionNueva>): RetencionNueva => ({
  impuesto: 'RENTA',
  conceptoCodigo: 'COMPRAS_GENERALES',
  conceptoId: 'n-compras',
  municipio: null,
  nombre: 'Compras generales',
  base: 1_000_000,
  valor: 25_000,
  tarifa: 0.025,
  texto: 'Retengo compras generales.',
  ...p,
});

describe('compararRecalculo', () => {
  it('con los mismos insumos y la misma norma no hay diferencias (T20)', () => {
    expect(compararRecalculo([viva({})], [nueva({})], 1)).toEqual([]);
  });

  it('una tarifa que cambia da la diferencia exacta', () => {
    const [d] = compararRecalculo(
      [viva({})],
      [nueva({ valor: 35_000, tarifa: 0.035 })],
      1,
    );
    expect(d.retencionId).toBe('rc-1');
    expect(d.antes).toBe(25_000);
    expect(d.nuevo).toBe(35_000);
    expect(d.diferencia).toBe(10_000);
    expect(d.texto).toMatch(/2,5 % → 3,5 %/);
  });

  it('se lleva a lo que sigue vivo después de las notas crédito', () => {
    // La nota devolvió el 40 %: lo vivo es 15.000; lo nuevo, 35.000 × 0,6.
    const [d] = compararRecalculo(
      [viva({ valor: 15_000, base: 600_000 })],
      [nueva({ valor: 35_000, tarifa: 0.035 })],
      0.6,
    );
    expect(d.nuevo).toBe(21_000);
    expect(d.diferencia).toBe(6_000);
    expect(d.base).toBe(600_000);
  });

  it('una retención que antes no existía (bajó la base mínima)', () => {
    const [d] = compararRecalculo(
      [],
      [nueva({ valor: 12_500, base: 500_000 })],
      1,
    );
    expect(d.retencionId).toBeNull();
    expect(d.antes).toBe(0);
    expect(d.diferencia).toBe(12_500);
    expect(d.texto).toMatch(/antes no se retenía/);
  });

  it('una retención que ya no corresponde (subió la base mínima)', () => {
    const [d] = compararRecalculo([viva({})], [], 1);
    expect(d.nuevo).toBe(0);
    expect(d.base).toBe(0);
    expect(d.baseAntes).toBe(1_000_000);
    expect(d.diferencia).toBe(-25_000);
    expect(d.texto).toMatch(/de más/);
  });

  it('en una venta habla de autorretención (§8.10)', () => {
    const [d] = compararRecalculo(
      [viva({ conceptoCodigo: 'AUTORRETENCION_ESPECIAL', valor: 8_000 })],
      [],
      1,
      'venta',
    );
    expect(d.diferencia).toBe(-8_000);
    expect(d.texto).toBe(
      'Con la norma vigente, esta venta ya no lleva autorretencion especial: se autorretuvieron $ 8.000 de más.',
    );
  });

  it('separa por impuesto y municipio', () => {
    const d = compararRecalculo(
      [
        viva({
          impuesto: 'ICA',
          conceptoCodigo: 'RETEICA',
          municipio: '11001',
          valor: 9_660,
        }),
      ],
      [
        nueva({
          impuesto: 'ICA',
          conceptoCodigo: 'RETEICA',
          municipio: '11001',
          valor: 9_660,
        }),
        nueva({
          impuesto: 'ICA',
          conceptoCodigo: 'RETEICA',
          municipio: '05001',
          valor: 5_000,
        }),
      ],
      1,
    );
    expect(d).toHaveLength(1);
    expect(d[0].municipio).toBe('05001');
  });
});
