import {
  CONCEPTOS_INVENTARIO,
  ORDEN_CONCEPTOS_INVENTARIO,
  conceptoDelFaltante,
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
