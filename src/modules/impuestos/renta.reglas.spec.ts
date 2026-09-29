import {
  armarCuota,
  calcularAnticipo,
  cuotasDe,
  estimarRenta,
  porcentajeAnticipo,
} from './renta.reglas';

describe('Renta estimada', () => {
  it('utilidad más lo que no se resta, por la tarifa, menos lo anticipado', () => {
    const r = estimarRenta({
      anio: 2026,
      utilidad: 21_345_600,
      gmf: 780_000,
      multas: 120_000,
      factorZomac: 1,
      retenciones: 1_284_500,
      anticipoAnterior: 900_000,
      impuestoNetoAnterior: null,
      anioDeclaracion: null,
      cuotas: 2,
    });
    expect(r.utilidad).toBe(21_346_000);
    expect(r.gmfNoDeducible).toBe(390_000);
    expect(r.rentaLiquida).toBe(21_856_000);
    // 21.856.000 × 35 % = 7.649.600 → 7.650.000
    expect(r.impuesto).toBe(7_650_000);
    expect(r.retenciones).toBe(1_285_000);
    // Anticipo: 7.650.000 × 75 % − 1.285.000 = 4.452.500 → 4.453.000
    expect(r.anticipoSiguiente.valor).toBe(4_453_000);
    // 7.650.000 + 4.453.000 − 1.285.000 − 900.000
    expect(r.saldo).toBe(9_918_000);
    expect(r.cuotas).toEqual([
      { numero: 1, valor: 4_959_000 },
      { numero: 2, valor: 4_959_000 },
    ]);
  });

  it('una sociedad ZOMAC paga la parte del año', () => {
    const r = estimarRenta({
      anio: 2026,
      utilidad: 10_000_000,
      gmf: 0,
      multas: 0,
      factorZomac: 0.5,
      retenciones: 0,
      anticipoAnterior: null,
      impuestoNetoAnterior: null,
      anioDeclaracion: 1,
      cuotas: 2,
    });
    expect(r.tarifa).toBeCloseTo(0.175);
    expect(r.impuesto).toBe(1_750_000);
    // Primer año: 25 %.
    expect(r.anticipoSiguiente.valor).toBe(438_000);
  });

  it('una pérdida no paga, y lo retenido queda a favor', () => {
    const r = estimarRenta({
      anio: 2026,
      utilidad: -3_000_000,
      gmf: 100_000,
      multas: 0,
      factorZomac: 1,
      retenciones: 400_000,
      anticipoAnterior: null,
      impuestoNetoAnterior: null,
      anioDeclaracion: 5,
      cuotas: 2,
    });
    expect(r.rentaLiquida).toBe(0);
    expect(r.impuesto).toBe(0);
    expect(r.anticipoSiguiente.valor).toBe(0);
    expect(r.saldo).toBe(-400_000);
    expect(r.cuotas).toEqual([]);
  });

  it('el anticipo: porcentaje por año y el menor de los dos procedimientos', () => {
    expect(porcentajeAnticipo(1)).toBe(0.25);
    expect(porcentajeAnticipo(2)).toBe(0.5);
    expect(porcentajeAnticipo(3)).toBe(0.75);
    const a = calcularAnticipo({
      impuestoNeto: 10_000_000,
      impuestoNetoAnterior: 6_000_000,
      retenciones: 1_000_000,
      anioDeclaracion: 4,
    });
    expect(a.procedimiento1).toBe(6_500_000);
    expect(a.procedimiento2).toBe(5_000_000);
    expect(a.valor).toBe(5_000_000);
  });

  it('cuotas parejas; la última se lleva lo que sobra', () => {
    expect(cuotasDe(10_001_000, 3)).toEqual([
      { numero: 1, valor: 3_334_000 },
      { numero: 2, valor: 3_334_000 },
      { numero: 3, valor: 3_333_000 },
    ]);
  });
});

describe('El pago de una cuota', () => {
  const cuenta = (codigo: string, saldo: number) => ({
    cuentaId: codigo,
    codigo,
    nombre: codigo,
    saldo,
  });

  it('debita la 2404, la de más saldo primero, más los intereses', () => {
    const r = armarCuota({
      valor: 5_000_000,
      intereses: 30_000,
      saldos2404: [cuenta('240410', 1_000_000), cuenta('240405', 4_500_000)],
      cuentaIntereses: { cuentaId: 'i', codigo: '530520', nombre: 'Intereses' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partidas.map((p) => [p.codigo, p.debito])).toEqual([
      ['240405', 4_500_000],
      ['240410', 500_000],
      ['530520', 30_000],
    ]);
    expect(r.total).toBe(5_030_000);
  });

  it('sin la renta causada no se paga', () => {
    const r = armarCuota({
      valor: 1_000_000,
      intereses: 0,
      saldos2404: [],
      cuentaIntereses: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('no está causada');
  });
});
