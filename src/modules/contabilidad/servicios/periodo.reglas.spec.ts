import {
  compararPeriodos,
  dejaHueco,
  etiquetaPeriodo,
  mesAnterior,
  mesSiguiente,
  mismoPeriodo,
  periodoDeFecha,
  grupoDe,
  mesesACrear,
  primerDiaDelPeriodo,
  type Periodo,
} from './periodo.reglas';

const p = (anio: number, mes: number): Periodo => ({ anio, mes });

// Las fechas se construyen con componentes y no con cadenas: `new Date('2026-03-15')`
// se interpreta como UTC y en Colombia (UTC-5) retrocede al 14 de marzo.
const fecha = (anio: number, mes: number, dia = 15): Date =>
  new Date(anio, mes - 1, dia);

describe('periodoDeFecha', () => {
  describe('con año fiscal calendario (cierre en diciembre)', () => {
    it('el período es el mes de la fecha', () => {
      expect(periodoDeFecha(fecha(2026, 3), 12)).toEqual(p(2026, 3));
    });

    it('enero y diciembre son del año que dice el calendario', () => {
      expect(periodoDeFecha(fecha(2026, 1, 1), 12)).toEqual(p(2026, 1));
      expect(periodoDeFecha(fecha(2026, 12, 31), 12)).toEqual(p(2026, 12));
    });
  });

  describe('con año fiscal que cierra en junio', () => {
    // El ejercicio va de julio a junio. Julio de 2026 pertenece al ejercicio que
    // termina en junio de 2027, así que su año fiscal es 2027.
    it('los meses posteriores al cierre pertenecen al año fiscal siguiente', () => {
      expect(periodoDeFecha(fecha(2026, 7), 6)).toEqual(p(2027, 7));
      expect(periodoDeFecha(fecha(2026, 12), 6)).toEqual(p(2027, 12));
    });

    it('los meses hasta el cierre pertenecen al año fiscal en curso', () => {
      expect(periodoDeFecha(fecha(2026, 6), 6)).toEqual(p(2026, 6));
      expect(periodoDeFecha(fecha(2026, 1), 6)).toEqual(p(2026, 1));
    });
  });

  it('el mes siempre es el del calendario, no uno renumerado desde el arranque fiscal', () => {
    // Con cierre en junio, julio es el primer mes del ejercicio y aun así se
    // llama 7: un balance de "mes 1" no se podría cotejar contra un extracto.
    expect(periodoDeFecha(fecha(2026, 7), 6).mes).toBe(7);
  });
});

describe('mesAnterior / mesSiguiente', () => {
  it('retroceden y avanzan dentro del año', () => {
    expect(mesAnterior(p(2026, 5))).toEqual(p(2026, 4));
    expect(mesSiguiente(p(2026, 5))).toEqual(p(2026, 6));
  });

  it('cruzan el año en enero y en diciembre', () => {
    expect(mesAnterior(p(2026, 1))).toEqual(p(2025, 12));
    expect(mesSiguiente(p(2026, 12))).toEqual(p(2027, 1));
  });
});

describe('compararPeriodos', () => {
  it('ordena por año antes que por mes', () => {
    // Diciembre de 2025 es anterior a enero de 2026 aunque su mes sea mayor.
    expect(compararPeriodos(p(2025, 12), p(2026, 1))).toBeLessThan(0);
  });

  it('ordena por mes dentro del mismo año', () => {
    expect(compararPeriodos(p(2026, 3), p(2026, 7))).toBeLessThan(0);
    expect(compararPeriodos(p(2026, 7), p(2026, 3))).toBeGreaterThan(0);
  });

  it('sirve para ordenar una lista', () => {
    const desordenados = [p(2026, 3), p(2025, 12), p(2026, 1)];
    expect([...desordenados].sort(compararPeriodos)).toEqual([
      p(2025, 12),
      p(2026, 1),
      p(2026, 3),
    ]);
  });
});

describe('mismoPeriodo', () => {
  it('compara por valor, no por identidad', () => {
    expect(mismoPeriodo(p(2026, 3), p(2026, 3))).toBe(true);
    expect(mismoPeriodo(p(2026, 3), p(2026, 4))).toBe(false);
    expect(mismoPeriodo(p(2026, 3), p(2025, 3))).toBe(false);
  });
});

describe('etiquetaPeriodo', () => {
  it('rellena el mes con cero para que ordene como texto', () => {
    expect(etiquetaPeriodo(p(2026, 3))).toBe('2026-03');
    expect(etiquetaPeriodo(p(2026, 12))).toBe('2026-12');
  });
});

describe('dejaHueco', () => {
  it('el primer período de la empresa nunca deja hueco', () => {
    expect(dejaHueco([], p(2026, 3))).toBe(false);
  });

  it('abrir el mes siguiente al último no deja hueco', () => {
    expect(dejaHueco([p(2026, 1), p(2026, 2)], p(2026, 3))).toBe(false);
  });

  it('saltarse un mes deja hueco', () => {
    // Abrir marzo con febrero sin abrir: el saldo inicial de marzo saldría del
    // saldo final de un febrero que no existe.
    expect(dejaHueco([p(2026, 1)], p(2026, 3))).toBe(true);
  });

  it('abrir hacia atrás del primero no deja hueco', () => {
    // Es lo que hace falta al migrar saldos de un sistema anterior.
    expect(dejaHueco([p(2026, 3)], p(2026, 1))).toBe(false);
    expect(dejaHueco([p(2026, 3)], p(2025, 11))).toBe(false);
  });

  it('rellenar un hueco intermedio no deja hueco', () => {
    expect(dejaHueco([p(2026, 1), p(2026, 3)], p(2026, 2))).toBe(false);
  });

  it('cruza el año correctamente', () => {
    expect(dejaHueco([p(2025, 12)], p(2026, 1))).toBe(false);
    expect(dejaHueco([p(2025, 11)], p(2026, 1))).toBe(true);
  });
});

describe('mesesACrear', () => {
  it('sin períodos, solo el actual', () => {
    expect(mesesACrear([], { anio: 2026, mes: 9 })).toEqual([
      { anio: 2026, mes: 9 },
    ]);
  });

  it('desde el siguiente al último hasta el actual, sin huecos', () => {
    expect(
      mesesACrear([{ anio: 2026, mes: 6 }], { anio: 2026, mes: 9 }),
    ).toEqual([
      { anio: 2026, mes: 7 },
      { anio: 2026, mes: 8 },
      { anio: 2026, mes: 9 },
    ]);
  });

  it('cruza el año', () => {
    expect(
      mesesACrear([{ anio: 2026, mes: 11 }], { anio: 2027, mes: 1 }),
    ).toEqual([
      { anio: 2026, mes: 12 },
      { anio: 2027, mes: 1 },
    ]);
  });

  it('si el actual ya existe, nada', () => {
    expect(
      mesesACrear([{ anio: 2026, mes: 9 }], { anio: 2026, mes: 9 }),
    ).toEqual([]);
  });
});

describe('primerDiaDelPeriodo', () => {
  it('año calendario', () => {
    expect(primerDiaDelPeriodo({ anio: 2026, mes: 9 }, 12)).toBe('2026-09-01');
  });

  it('año fiscal que cierra en junio: julio del ejercicio 2027 es 2026', () => {
    expect(primerDiaDelPeriodo({ anio: 2027, mes: 7 }, 6)).toBe('2026-07-01');
    expect(primerDiaDelPeriodo({ anio: 2027, mes: 3 }, 6)).toBe('2027-03-01');
  });
});

describe('grupoDe', () => {
  const p = { anio: 2026, mes: 8 };
  it('agrupa por mes, trimestre, semestre y año', () => {
    expect(grupoDe(p, 'MENSUAL')).toBe('2026-08');
    expect(grupoDe(p, 'TRIMESTRAL')).toBe('2026-T3');
    expect(grupoDe(p, 'SEMESTRAL')).toBe('2026-S2');
    expect(grupoDe(p, 'ANUAL')).toBe('2026');
  });

  it('los bordes de trimestre y semestre', () => {
    expect(grupoDe({ anio: 2026, mes: 3 }, 'TRIMESTRAL')).toBe('2026-T1');
    expect(grupoDe({ anio: 2026, mes: 4 }, 'TRIMESTRAL')).toBe('2026-T2');
    expect(grupoDe({ anio: 2026, mes: 6 }, 'SEMESTRAL')).toBe('2026-S1');
    expect(grupoDe({ anio: 2026, mes: 7 }, 'SEMESTRAL')).toBe('2026-S2');
  });
});
