import {
  CONCEPTOS_INVENTARIO,
  ORDEN_CONCEPTOS_INVENTARIO,
  conceptoDelFaltante,
  conceptosInventarioPara,
} from './cuentas-inventario.reglas';

describe('conceptoDelFaltante', () => {
  it('sin tratamiento se rechaza: lo sabe quien contó la bodega', () => {
    expect(conceptoDelFaltante(undefined).ok).toBe(false);
  });

  it('lo asume la empresa o lo paga el responsable', () => {
    expect(conceptoDelFaltante('EMPRESA')).toEqual({
      ok: true,
      concepto: 'FALTANTE_ASUMIDO',
    });
    expect(conceptoDelFaltante('RESPONSABLE')).toEqual({
      ok: true,
      concepto: 'FALTANTE_COBRABLE',
    });
  });
});

describe('CONCEPTOS_INVENTARIO', () => {
  it('cada concepto crea una cuenta dentro de su familia', () => {
    for (const c of ORDEN_CONCEPTOS_INVENTARIO) {
      const def = CONCEPTOS_INVENTARIO[c];
      expect(def.codigoCrear.startsWith(def.familia)).toBe(true);
    }
  });

  it('las cuentas por defecto son las acordadas', () => {
    expect(
      Object.fromEntries(
        ORDEN_CONCEPTOS_INVENTARIO.map((c) => [
          c,
          CONCEPTOS_INVENTARIO[c].codigoCrear,
        ]),
      ),
    ).toEqual({
      INVENTARIO: '143501',
      INGRESO: '413595',
      COSTO_VENTA: '613595',
      SOBRANTE: '429505',
      FALTANTE_ASUMIDO: '529595',
      FALTANTE_COBRABLE: '136530',
    });
  });

  it('solo el faltante cobrable exige tercero', () => {
    expect(
      ORDEN_CONCEPTOS_INVENTARIO.filter(
        (c) => CONCEPTOS_INVENTARIO[c].exigeTercero === true,
      ),
    ).toEqual(['FALTANTE_COBRABLE']);
  });
});

describe('conceptosInventarioPara', () => {
  it('un comercio usa 4135 y 6135', () => {
    const c = conceptosInventarioPara('4135');
    expect(c.INGRESO.familia).toBe('4135');
    expect(c.COSTO_VENTA.codigoCrear).toBe('613595');
  });

  it('una empresa de servicios usa 4155 y 6155, sin 413595', () => {
    const c = conceptosInventarioPara('4155');
    expect(c.INGRESO).toMatchObject({ familia: '4155', codigoCrear: '415595' });
    expect(c.COSTO_VENTA).toMatchObject({
      familia: '6155',
      codigoCrear: '615595',
    });
  });

  it('sin actividad, las de comercio', () => {
    expect(conceptosInventarioPara(null).INGRESO.familia).toBe('4135');
  });
});
