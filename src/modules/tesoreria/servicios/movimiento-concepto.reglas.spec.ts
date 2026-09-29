import {
  admiteSinFactura,
  gmfDe,
  problemaDeDireccion,
  valorMovido,
} from './movimiento-concepto.reglas';

describe('movimiento-concepto.reglas', () => {
  it('un gasto no entra; un ingreso no sale; el «no gasto» va para los dos lados', () => {
    expect(problemaDeDireccion('GASTO', 'ENTRADA')).not.toBeNull();
    expect(problemaDeDireccion('INGRESO', 'SALIDA')).not.toBeNull();
    expect(problemaDeDireccion('NO_GASTO', 'ENTRADA')).toBeNull();
    expect(problemaDeDireccion('NO_GASTO', 'SALIDA')).toBeNull();
    expect(problemaDeDireccion('GASTO', 'SALIDA')).toBeNull();
  });

  it('sin factura solo lo financiero, los impuestos y los «no gasto»', () => {
    expect(admiteSinFactura('GASTO', '530515')).toBe(true);
    expect(admiteSinFactura('GASTO', '511595')).toBe(true);
    expect(admiteSinFactura('GASTO', '512010')).toBe(false); // arriendo: con factura
    expect(admiteSinFactura('GASTO', '513550')).toBe(false); // fletes: con factura
    expect(admiteSinFactura('NO_GASTO', '210510')).toBe(true);
  });

  it('el 4×1000 al peso, y nada en la cuenta exenta', () => {
    expect(gmfDe(1_048_600, false)).toBe(4194);
    expect(gmfDe(1_048_600, true)).toBe(0);
  });

  it('lo que sale es el bruto menos lo retenido', () => {
    expect(valorMovido(2_000_000, [{ valor: 50_000 }])).toEqual({
      ok: true,
      valor: 1_950_000,
    });
    expect(valorMovido(1_000, [{ valor: 1_000 }]).ok).toBe(false);
  });
});
