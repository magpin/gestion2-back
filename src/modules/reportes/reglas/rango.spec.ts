import {
  aMano,
  corteAMano,
  resolver,
  resolverCorte,
  ultimoDiaDe,
} from './rango';

describe('los atajos de fecha', () => {
  describe('este mes', () => {
    it('va del primero a hoy', () => {
      expect(resolver('ESTE_MES', '2026-09-21')).toMatchObject({
        desde: '2026-09-01',
        hasta: '2026-09-21',
        relativo: true,
      });
    });

    it('el primero del mes es un rango de un día', () => {
      expect(resolver('ESTE_MES', '2026-09-01')).toMatchObject({
        desde: '2026-09-01',
        hasta: '2026-09-01',
      });
    });
  });

  describe('el mes pasado', () => {
    it('va de su primero a su último día', () => {
      expect(resolver('MES_PASADO', '2026-09-21')).toMatchObject({
        desde: '2026-08-01',
        hasta: '2026-08-31',
      });
    });

    it('en enero cruza al año anterior', () => {
      expect(resolver('MES_PASADO', '2026-01-15')).toMatchObject({
        desde: '2025-12-01',
        hasta: '2025-12-31',
      });
    });

    it('sabe cuántos días tiene febrero', () => {
      expect(resolver('MES_PASADO', '2026-03-10').hasta).toBe('2026-02-28');
      expect(resolver('MES_PASADO', '2024-03-10').hasta).toBe('2024-02-29');
    });
  });

  describe('este año', () => {
    it('va del primero de enero a hoy, no a diciembre', () => {
      // Un reporte «de este año» que llegara al 31 de diciembre incluiría meses
      // que no han pasado: el total sale igual, pero cualquier promedio por día
      // o por mes sale mal y nadie lo nota.
      expect(resolver('ESTE_ANIO', '2026-09-21')).toMatchObject({
        desde: '2026-01-01',
        hasta: '2026-09-21',
      });
    });
  });

  describe('a mano', () => {
    it('no es relativo, y por eso no se mueve nunca', () => {
      expect(aMano('2026-03-01', '2026-03-15')).toEqual({
        desde: '2026-03-01',
        hasta: '2026-03-15',
        etiqueta: 'fechas fijas',
        relativo: false,
      });
    });
  });

  describe('el último día del mes', () => {
    it.each([
      [2026, 1, 31],
      [2026, 2, 28],
      [2024, 2, 29],
      [2000, 2, 29],
      [1900, 2, 28],
      [2026, 4, 30],
      [2026, 12, 31],
    ])('%i-%i tiene %i días', (anio, mes, dias) => {
      expect(ultimoDiaDe(anio, mes)).toBe(dias);
    });
  });

  it('todos los atajos se marcan como relativos', () => {
    // Es lo que hace que la pantalla pueda advertir, al guardar, que el reporte
    // va a correr sobre otras fechas la próxima vez.
    for (const atajo of ['ESTE_MES', 'MES_PASADO', 'ESTE_ANIO'] as const) {
      expect(resolver(atajo, '2026-09-21').relativo).toBe(true);
    }
  });
});

describe('los atajos de corte', () => {
  it('hoy es hoy', () => {
    expect(resolverCorte('HOY', '2026-09-21')).toEqual({
      corte: '2026-09-21',
      etiqueta: 'hoy',
      relativo: true,
    });
  });

  it('el cierre del mes pasado es su último día', () => {
    expect(resolverCorte('CIERRE_MES_PASADO', '2026-09-21').corte).toBe(
      '2026-08-31',
    );
  });

  it('en enero, el cierre del mes pasado es el 31 de diciembre del año anterior', () => {
    expect(resolverCorte('CIERRE_MES_PASADO', '2026-01-10').corte).toBe(
      '2025-12-31',
    );
  });

  it('en marzo sabe cuántos días tuvo febrero', () => {
    expect(resolverCorte('CIERRE_MES_PASADO', '2024-03-05').corte).toBe(
      '2024-02-29',
    );
  });

  it('una fecha a mano queda fija', () => {
    expect(corteAMano('2026-06-30')).toEqual({
      corte: '2026-06-30',
      etiqueta: 'fecha fija',
      relativo: false,
    });
  });
});
