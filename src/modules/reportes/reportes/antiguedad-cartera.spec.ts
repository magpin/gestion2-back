import { armar, tramoDe } from './antiguedad-cartera';
import type { FacturaLeida } from './ventas-por-cliente';

/**
 * El fixture sale de `docs/mocks/reportes-pdf-diseno/AntiguedadDeCartera.dc.html`:
 * ocho clientes, $ 40.070.000 repartidos en cinco tramos que suman exacto.
 *
 * Las fechas se eligieron para que cada factura caiga en el tramo que el diseño
 * le da. Ese es el ejercicio que importa: el diseño dice **cuánto** hay en cada
 * tramo, y acá se comprueba que partiendo de facturas con su fecha se llega a
 * los mismos montos.
 */
const CORTE = '2026-09-21';
const PLAZO = 30;

const f = (
  cliente: string,
  numero: string,
  fecha: string,
  saldo: number,
): FacturaLeida => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado: 'EMITIDA',
  total: saldo.toFixed(2),
  pagado: '0.00',
});

/** Con corte el 21 de septiembre y 30 días de plazo. */
const EN = {
  sinVencer: '2026-09-10', //  11 días → 0 vencidos
  d1a30: '2026-08-10', //      42 días → 12 vencidos
  d31a60: '2026-07-10', //     73 días → 43 vencidos
  d61a90: '2026-06-10', //    103 días → 73 vencidos
  masDe90: '2026-03-10', //   195 días → 165 vencidos
};

const DISENO: FacturaLeida[] = [
  f('Almacenes del Sur S.A.S.', 'FV-1042', EN.sinVencer, 8_930_000),
  f('Almacenes del Sur S.A.S.', 'FV-1038', EN.d1a30, 5_100_000),
  f('Constructora Meridiano', 'FV-1046', EN.sinVencer, 7_100_000),
  f('Suministros Andes Ltda.', 'FV-0980', EN.masDe90, 4_850_000),
  f('Inversiones La Loma S.A.S.', 'FV-1047', EN.sinVencer, 3_960_000),
  f('Comercial Aburrá', 'FV-1010', EN.d1a30, 1_470_000),
  f('Comercial Aburrá', 'FV-0995', EN.d31a60, 2_080_000),
  f('Obras y Montajes del Valle', 'FV-0990', EN.d61a90, 3_200_000),
  f('Ferretería El Tornillo', 'FV-1040', EN.sinVencer, 1_200_000),
  f('Ferretería El Tornillo', 'FV-1020', EN.d1a30, 980_000),
  f('Jorge Restrepo', 'FV-1043', EN.sinVencer, 1_200_000),
];

describe('Antigüedad de saldos de cartera', () => {
  const hoja = armar(DISENO, CORTE, PLAZO);

  it('da el total y los clientes del diseño', () => {
    expect(hoja.resumen.total).toBe('$ 40.070.000');
    expect(hoja.resumen.clientes).toBe(8);
  });

  /**
   * Los montos por tramo son los del diseño. **Dos redondeos no coinciden, y
   * es a propósito:** el diseño muestra 7.550.000 como «7,5 M» y 4.850.000 como
   * «4,8 M», y los dos son 7,6 y 4,9 al redondear. Es el artefacto clásico de
   * `toFixed` sobre coma flotante —7,55 en binario queda apenas por debajo de
   * 7,55, así que se redondea hacia abajo—. Acá las cifras se suman en enteros
   * y se redondean como corresponde, así que dan medio millón más. No es una
   * desviación del diseño: es el diseño el que tenía el error, y en una hoja
   * que alguien firma gana la aritmética.
   */
  it('y reparte los cinco tramos como el diseño', () => {
    const porTramo = Object.fromEntries(hoja.tramos.map((t) => [t.clave, t]));
    expect(porTramo.SIN_VENCER.monto).toBe('22,4 M');
    expect(porTramo.SIN_VENCER.parte).toBe('56 %');
    expect(porTramo.D1_30.centavos).toBe(7_550_000_00);
    expect(porTramo.D1_30.monto).toBe('7,6 M');
    expect(porTramo.D31_60.monto).toBe('2,1 M');
    expect(porTramo.D61_90.monto).toBe('3,2 M');
    expect(porTramo.D90_MAS.centavos).toBe(4_850_000_00);
    expect(porTramo.D90_MAS.monto).toBe('4,9 M');
  });

  /** La propiedad que hace que la hoja se pueda firmar, otra vez. */
  it('los tramos suman el total, y los clientes también', () => {
    const porTramos = hoja.tramos.reduce((n, t) => n + t.centavos, 0);
    const porClientes = hoja.clientes.reduce((n, c) => n + c.centavos, 0);
    expect(porTramos).toBe(porClientes);
    expect(hoja.resumen.total).toBe('$ 40.070.000');
    expect(porTramos).toBe(40_070_000_00);
  });

  it('al día más vencida dan el cien por ciento', () => {
    expect(hoja.resumen.alDiaPorciento + hoja.resumen.vencidaPorciento).toBe(
      100,
    );
  });

  it('nombra al único cliente con más de 90 días', () => {
    expect(hoja.resumen.masDe90Detalle).toBe(
      '1 cliente · Suministros Andes Ltda.',
    );
  });

  describe('los clientes', () => {
    const porNombre = Object.fromEntries(
      hoja.clientes.map((c) => [c.cliente, c]),
    );

    it('van del mayor al menor', () => {
      const saldos = hoja.clientes.map((c) => c.centavos);
      expect(saldos).toEqual([...saldos].sort((a, b) => b - a));
      expect(hoja.clientes[0].cliente).toBe('Almacenes del Sur S.A.S.');
    });

    it('con la barra proporcional al que más debe', () => {
      // 14.030.000 llena la barra; 7.100.000 llega a la mitad. Sin esto todas
      // medirían lo mismo y la gráfica no diría quién debe más.
      expect(porNombre['Almacenes del Sur S.A.S.'].ancho).toBe(100);
      expect(porNombre['Constructora Meridiano'].ancho).toBeCloseTo(50.6, 1);
    });

    it('y dicen cuánto de lo suyo está vencido', () => {
      expect(porNombre['Almacenes del Sur S.A.S.'].estado).toBe('36 % vencido');
      expect(porNombre['Constructora Meridiano'].estado).toBe('al día');
      expect(porNombre['Suministros Andes Ltda.'].estado).toBe('100 % vencido');
      expect(porNombre['Ferretería El Tornillo'].estado).toBe('45 % vencido');
    });

    it('y su barra se parte en los tramos que tienen algo', () => {
      // Dos pedazos: lo que está al día y lo que lleva menos de un mes.
      expect(porNombre['Almacenes del Sur S.A.S.'].pedazos).toHaveLength(2);
      // Uno solo: todo al día.
      expect(porNombre['Jorge Restrepo'].pedazos).toHaveLength(1);
    });
  });

  describe('qué entra en la cartera', () => {
    it('lo pagado no', () => {
      const pagada = armar(
        [
          {
            ...f('Cliente', 'FV-1', EN.sinVencer, 1_000_000),
            pagado: '1000000.00',
          },
        ],
        CORTE,
        PLAZO,
      );
      expect(pagada.clientes).toEqual([]);
      expect(pagada.resumen.total).toBe('$ 0');
    });

    it('lo anulado tampoco, aunque no esté pagado', () => {
      const anulada = armar(
        [
          {
            ...f('Cliente', 'FV-1', EN.sinVencer, 1_000_000),
            estado: 'ANULADA' as const,
          },
        ],
        CORTE,
        PLAZO,
      );
      expect(anulada.clientes).toEqual([]);
    });

    it('lo pagado a medias, solo por el saldo', () => {
      const parcial = armar(
        [
          {
            ...f('Cliente', 'FV-1', EN.sinVencer, 1_000_000),
            pagado: '400000.00',
          },
        ],
        CORTE,
        PLAZO,
      );
      expect(parcial.resumen.total).toBe('$ 600.000');
    });
  });

  describe('los bordes de los tramos', () => {
    it('el día del plazo todavía está al día', () => {
      expect(tramoDe(0)).toBe('SIN_VENCER');
    });

    it('el día siguiente ya cuenta', () => {
      expect(tramoDe(1)).toBe('D1_30');
    });

    it('y cada tramo termina donde empieza el que sigue', () => {
      expect(tramoDe(30)).toBe('D1_30');
      expect(tramoDe(31)).toBe('D31_60');
      expect(tramoDe(60)).toBe('D31_60');
      expect(tramoDe(61)).toBe('D61_90');
      expect(tramoDe(90)).toBe('D61_90');
      expect(tramoDe(91)).toBe('D90_MAS');
    });

    it('una factura anterior al plazo no cae en un tramo negativo', () => {
      // Pasa con una factura de fecha futura, que el sistema permite.
      expect(tramoDe(-40)).toBe('SIN_VENCER');
    });
  });

  it('sin cartera no se cae, y lo dice', () => {
    const vacia = armar([], CORTE, PLAZO);
    expect(vacia.clientes).toEqual([]);
    expect(vacia.resumen.total).toBe('$ 0');
    expect(vacia.resumen.alDiaPorciento).toBe(0);
    expect(vacia.resumen.masDe90Detalle).toBe('ninguno');
    expect(vacia.tramos).toHaveLength(5);
  });

  it('el plazo que se asumió va en el modelo, para que la hoja lo declare', () => {
    expect(hoja.plazo).toBe(30);
    expect(armar([], CORTE, 45).plazo).toBe(45);
  });
});
