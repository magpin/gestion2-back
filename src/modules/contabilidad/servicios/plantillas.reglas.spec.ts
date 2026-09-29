import {
  cuotaMensual,
  depreciacion,
  inventario,
  prima,
  reconocerClase,
  reconocerPlantilla,
  seguros,
} from './plantillas.reglas';

const cuadra = (r: Array<{ debito: number; credito: number }>) =>
  r.reduce((s, x) => s + x.debito, 0) === r.reduce((s, x) => s + x.credito, 0);

describe('plantillas del comprobante manual', () => {
  it('deprecia en línea recta, a la cuenta de la clase', () => {
    const p = depreciacion({
      clase: 'COMPUTO',
      costo: 24_750_000,
      meses: 60,
      periodo: 'septiembre de 2026',
    });
    expect(p.renglones.map((r) => [r.codigo, r.debito, r.credito])).toEqual([
      ['516020', 412_500, 0],
      ['159220', 0, 412_500],
    ]);
    expect(p.explicacion[1]).toBe('24.750.000 ÷ 60 = 412.500');
    expect(cuadra(p.renglones)).toBe(true);
  });

  it('la cuota se redondea al peso', () => {
    expect(cuotaMensual(1_000_000, 3)).toBe(333_333);
    expect(() => cuotaMensual(1_000, 0)).toThrow();
    expect(() => cuotaMensual(0, 12)).toThrow();
  });

  it('provisiona la prima al 8,33 % contra la 261020', () => {
    const p = prima({ salarios: 10_000_000, periodo: 'septiembre de 2026' });
    expect(p.renglones.map((r) => [r.codigo, r.debito, r.credito])).toEqual([
      ['510536', 833_000, 0],
      ['261020', 0, 833_000],
    ]);
  });

  it('amortiza el seguro desde la 170520, al gasto del ramo', () => {
    const p = seguros({
      ramo: 'INCENDIO',
      valor: 2_400_000,
      meses: 12,
      periodo: 'septiembre de 2026',
    });
    expect(p.renglones.map((r) => [r.codigo, r.debito, r.credito])).toEqual([
      ['513025', 200_000, 0],
      ['170520', 0, 200_000],
    ]);
  });

  it('el conteo de inventario no propone asiento: lleva al ajuste', () => {
    const p = inventario();
    expect(p.renglones).toEqual([]);
    expect(p.redirigir?.a).toBe('AJUSTE_INVENTARIO');
  });

  it('reconoce la plantilla por palabras, sin tildes', () => {
    expect(
      reconocerPlantilla(
        'Depreciación de septiembre de los equipos de cómputo',
      ),
    ).toBe('DEPRECIACION');
    expect(reconocerPlantilla('la prima de junio')).toBe('PRIMA');
    expect(reconocerPlantilla('amortizar la póliza')).toBe('SEGUROS');
    expect(reconocerPlantilla('contamos la bodega y faltan 3')).toBe(
      'INVENTARIO',
    );
    expect(reconocerPlantilla('pagamos el arriendo')).toBeNull();
  });

  it('reconoce la clase de activo', () => {
    expect(reconocerClase('los equipos de cómputo')).toBe('COMPUTO');
    expect(reconocerClase('el camión')).toBe('FLOTA');
    expect(reconocerClase('algo raro')).toBeNull();
  });
});
