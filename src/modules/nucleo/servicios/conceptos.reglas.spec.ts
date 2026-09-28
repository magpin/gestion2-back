import {
  CONCEPTOS_INICIALES,
  afectaResultado,
  codigoPropio,
  esOperacional,
  problemaDeCuenta,
} from './conceptos.reglas';

describe('conceptos.reglas', () => {
  describe('problemaDeCuenta', () => {
    it('un gasto va a clase 5', () => {
      expect(
        problemaDeCuenta('GASTO', { codigo: '513550', esAuxiliar: true }),
      ).toBeNull();
      expect(
        problemaDeCuenta('GASTO', { codigo: '220505', esAuxiliar: true }),
      ).toMatch(/clase 5; la 220505 es de clase 2/);
    });

    it('un «no gasto» no puede tocar el resultado', () => {
      expect(
        problemaDeCuenta('NO_GASTO', { codigo: '210510', esAuxiliar: true }),
      ).toBeNull();
      expect(
        problemaDeCuenta('NO_GASTO', { codigo: '530520', esAuxiliar: true }),
      ).not.toBeNull();
    });

    it('un costo va a clase 6 o 7', () => {
      expect(
        problemaDeCuenta('COSTO', { codigo: '613595', esAuxiliar: true }),
      ).toBeNull();
      expect(
        problemaDeCuenta('COSTO', { codigo: '720505', esAuxiliar: true }),
      ).toBeNull();
      expect(
        problemaDeCuenta('COSTO', { codigo: '513550', esAuxiliar: true }),
      ).not.toBeNull();
    });

    it('una cuenta que agrupa no recibe el concepto', () => {
      expect(
        problemaDeCuenta('GASTO', { codigo: '5135', esAuxiliar: false }),
      ).toMatch(/agrupa/);
    });
  });

  it('operacional se lee de la cuenta', () => {
    expect(esOperacional('413595')).toBe(true);
    expect(esOperacional('511595')).toBe(true); // D8: el 4×1000 es operacional
    expect(esOperacional('523560')).toBe(true);
    expect(esOperacional('421005')).toBe(false);
    expect(esOperacional('530520')).toBe(false);
    expect(esOperacional('210510')).toBeNull();
  });

  it('solo el «no gasto» queda fuera del resultado', () => {
    expect(afectaResultado('GASTO')).toBe(true);
    expect(afectaResultado('INGRESO')).toBe(true);
    expect(afectaResultado('NO_GASTO')).toBe(false);
  });

  describe('codigoPropio', () => {
    it('mayúsculas, sin tildes ni espacios', () => {
      expect(codigoPropio('Fumigación del local', new Set())).toBe(
        'PROPIO-FUMIGACION-DEL-LOCAL',
      );
    });

    it('no repite uno que ya existe', () => {
      expect(codigoPropio('Fumigación', new Set(['PROPIO-FUMIGACION']))).toBe(
        'PROPIO-FUMIGACION-2',
      );
    });

    it('un nombre sin letras ni números igual da un código válido', () => {
      expect(codigoPropio('¿?', new Set())).toMatch(/^[A-Z0-9-]{3,40}$/);
    });
  });

  describe('el catálogo inicial', () => {
    it('cada concepto va a un auxiliar de la clase de su tipo', () => {
      for (const c of CONCEPTOS_INICIALES) {
        expect([
          c.codigo,
          problemaDeCuenta(c.tipo, { codigo: c.cuenta, esAuxiliar: true }),
        ]).toEqual([c.codigo, null]);
        expect(c.cuenta).toMatch(/^\d{6}$/);
      }
    });

    it('códigos válidos y sin repetir', () => {
      const codigos = CONCEPTOS_INICIALES.map((c) => c.codigo);
      expect(new Set(codigos).size).toBe(codigos.length);
      for (const codigo of codigos) expect(codigo).toMatch(/^[A-Z0-9-]{3,40}$/);
    });

    it('ningún nombre se repite dentro de un tipo', () => {
      const claves = CONCEPTOS_INICIALES.map(
        (c) => `${c.tipo}:${c.nombre.toLowerCase()}`,
      );
      expect(new Set(claves).size).toBe(claves.length);
    });

    it('lo de socios y créditos es financiación', () => {
      for (const codigo of [
        'NG-CREDITO-ABONO',
        'NG-CREDITO-RECIBIDO',
        'NG-DIVIDENDOS',
      ]) {
        expect(
          CONCEPTOS_INICIALES.find((c) => c.codigo === codigo)?.tipoFlujo,
        ).toBe('FINANCIACION');
      }
    });

    it('anticipos en 133005 y 280505 (D11a), GMF en 511595 (D8)', () => {
      const cuenta = (codigo: string) =>
        CONCEPTOS_INICIALES.find((c) => c.codigo === codigo)?.cuenta;
      expect(cuenta('NG-ANTICIPO-PROVEEDOR')).toBe('133005');
      expect(cuenta('NG-ANTICIPO-CLIENTE')).toBe('280505');
      expect(cuenta('GTO-GMF')).toBe('511595');
    });
  });
});
