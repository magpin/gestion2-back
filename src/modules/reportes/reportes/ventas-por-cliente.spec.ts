import {
  armar,
  DIAS_PARA_VENCER,
  millones,
  pesos,
  type FacturaLeida,
} from './ventas-por-cliente';

/**
 * El fixture **son los datos del diseño**, sacados de
 * `docs/mocks/reportes-pdf-diseno/VentasPorCliente-pag2.dc.html`.
 *
 * No es comodidad: el LEEME del diseño promete que «las sumas cuadran entre el
 * resumen y el detalle», así que si el armador reproduce esos números, la hoja
 * que salga va a decir lo mismo que la que se aprobó. Y si algún día deja de
 * hacerlo, estas pruebas dicen exactamente en qué cifra.
 */
const RANGO = { desde: '2026-09-01', hasta: '2026-09-30' };

const f = (
  cliente: string,
  numero: string,
  fecha: string,
  total: number,
  pagado: number,
  estado: 'EMITIDA' | 'ANULADA' = 'EMITIDA',
): FacturaLeida => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado,
  total: total.toFixed(2),
  pagado: pagado.toFixed(2),
});

const DISENO: FacturaLeida[] = [
  f('Constructora Meridiano', 'FV-1033', '2026-09-04', 7_600_000, 7_600_000),
  f('Constructora Meridiano', 'FV-1041', '2026-09-17', 14_200_000, 14_200_000),
  f('Constructora Meridiano', 'FV-1046', '2026-09-20', 7_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1038', '2026-09-12', 5_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1042', '2026-09-18', 8_930_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1045', '2026-09-19', 5_100_000, 5_100_000),
  f('Ferretería El Tornillo', 'FV-1034', '2026-09-05', 2_750_000, 2_750_000),
  f('Ferretería El Tornillo', 'FV-1040', '2026-09-16', 3_480_000, 2_280_000),
  f('Distribuciones Norte', 'FV-1031', '2026-09-02', 4_150_000, 4_150_000),
  f('Distribuciones Norte', 'FV-1037', '2026-09-10', 0, 0, 'ANULADA'),
  f('Inversiones La Loma S.A.S.', 'FV-1047', '2026-09-20', 3_960_000, 0),
  f('Cliente de mostrador', 'FV-1032', '2026-09-03', 380_000, 380_000),
  f('Cliente de mostrador', 'FV-1036', '2026-09-08', 915_000, 915_000),
  f('Cliente de mostrador', 'FV-1039', '2026-09-15', 620_000, 620_000),
  f('Cliente de mostrador', 'FV-1044', '2026-09-19', 1_240_000, 1_240_000),
  f('Jorge Restrepo', 'FV-1035', '2026-09-06', 1_850_000, 1_850_000),
  f('Jorge Restrepo', 'FV-1043', '2026-09-18', 1_200_000, 0),
];

describe('Ventas del mes por cliente', () => {
  const hoja = armar(DISENO, RANGO);

  it('da los mismos totales que el diseño', () => {
    expect(hoja.resumen.totalFacturado).toBe('$ 68.575.000');
    expect(hoja.totalGeneral.porCobrar).toBe('$ 27.490.000');
    expect(hoja.resumen.clientes).toBe(7);
  });

  it('y los mismos subtotales por cliente', () => {
    const porNombre = Object.fromEntries(
      hoja.grupos.map((g) => [g.cliente, g]),
    );
    expect(porNombre['Constructora Meridiano'].total).toBe('$ 28.900.000');
    expect(porNombre['Constructora Meridiano'].porCobrar).toBe('$ 7.100.000');
    expect(porNombre['Almacenes del Sur S.A.S.'].total).toBe('$ 19.130.000');
    expect(porNombre['Almacenes del Sur S.A.S.'].porCobrar).toBe(
      '$ 14.030.000',
    );
    expect(porNombre['Jorge Restrepo'].total).toBe('$ 3.050.000');
  });

  /**
   * La propiedad que hace que la hoja se pueda firmar. Si esto se rompe, el
   * resumen y el detalle dicen cosas distintas en el mismo papel, y no hay
   * forma de saber cuál de los dos está mal.
   */
  it('el total general es la suma de los grupos, y cada grupo la de sus facturas', () => {
    const sumaGrupos = hoja.grupos.reduce((n, g) => n + g.centavos, 0);
    expect(hoja.totalGeneral.total).toBe(pesos(sumaGrupos));
    expect(hoja.resumen.totalFacturado).toBe(pesos(sumaGrupos));

    for (const grupo of hoja.grupos) {
      const suma = grupo.facturas
        .filter((factura) => !factura.anulada)
        .reduce(
          (n, factura) =>
            n + Number(factura.total.replace(/[^0-9]/g, '')) * 100,
          0,
        );
      expect(grupo.total).toBe(pesos(suma));
    }
  });

  it('y cobrado más por cobrar dan el total', () => {
    // En millones y redondeado a una decimal, que es como se muestra arriba.
    expect(hoja.resumen.cobrado).toBe(millones(68_575_000_00 - 27_490_000_00));
    expect(hoja.resumen.porCobrar).toBe(millones(27_490_000_00));
    expect(
      hoja.resumen.cobradoPorciento + hoja.resumen.porCobrarPorciento,
    ).toBe(100);
  });

  describe('las anuladas', () => {
    it('no suman', () => {
      // 17 facturas en la lista, 16 cuentan: la anulada queda afuera del total
      // y del conteo. Es el número que el diseño escribe al pie.
      expect(DISENO).toHaveLength(17);
      expect(hoja.totalGeneral.facturas).toBe(16);
    });

    it('pero se muestran, porque su número se consumió', () => {
      const norte = hoja.grupos.find(
        (g) => g.cliente === 'Distribuciones Norte',
      );
      expect(norte?.facturas.map((x) => x.numero)).toContain('FV-1037');
      expect(norte?.facturas.find((x) => x.numero === 'FV-1037')?.anulada).toBe(
        true,
      );
    });
  });

  describe('vencida es una convención, no un hecho', () => {
    // Ninguna tabla guarda fecha de vencimiento ni plazo: lo único que se puede
    // afirmar es «emitida hace más de N días y con saldo».
    const conSaldo = (fecha: string) => [
      f('Cliente', 'FV-1', fecha, 1_000_000, 0),
    ];

    it('con saldo y pasados los días, vencida', () => {
      const vieja = armar(conSaldo('2026-08-01'), RANGO);
      expect(vieja.grupos[0].facturas[0].situacion).toBe('VENCIDA');
    });

    it('con saldo y dentro del plazo, pendiente', () => {
      const nueva = armar(conSaldo('2026-09-20'), RANGO);
      expect(nueva.grupos[0].facturas[0].situacion).toBe('PENDIENTE');
    });

    it('se mide contra el corte del reporte, no contra hoy', () => {
      // Un reporte de agosto impreso en diciembre tiene que decir lo que decía
      // en agosto. Si se midiera contra el reloj, la misma hoja cambiaría de
      // contenido cada vez que se imprime.
      const justo = armar(conSaldo('2026-09-01'), {
        desde: '2026-09-01',
        hasta: `2026-10-01`,
      });
      expect(justo.grupos[0].facturas[0].situacion).toBe('PENDIENTE');

      const unDiaMas = armar(conSaldo('2026-09-01'), {
        desde: '2026-09-01',
        hasta: '2026-10-02',
      });
      expect(unDiaMas.grupos[0].facturas[0].situacion).toBe('VENCIDA');
      expect(DIAS_PARA_VENCER).toBe(30);
    });
  });

  describe('el pico y los días', () => {
    it('trae una barra por día del rango, incluidos los vacíos', () => {
      expect(hoja.porDia).toHaveLength(30);
      expect(hoja.porDia[0].rotulo).toBe('1');
      expect(hoja.escala).toBe('DIA');
      expect(hoja.porDia.some((d) => d.valor === 0)).toBe(true);
    });

    it('y señala el día de más ventas', () => {
      // El 17 de septiembre, con la factura de 14,2 M. Es el que el diseño
      // rotula sobre la barra.
      expect(hoja.pico?.clave).toBe('2026-09-17');
      expect(hoja.pico?.texto).toBe('mayor el 17 sep · 14,2 M');
    });

    it('un rango que cruza el mes rotula cada barra con su día, no con su posición', () => {
      const cruce = armar([], { desde: '2026-08-25', hasta: '2026-09-05' });
      expect(cruce.porDia.map((d) => d.rotulo)).toEqual([
        '25',
        '26',
        '27',
        '28',
        '29',
        '30',
        '31',
        '1',
        '2',
        '3',
        '4',
        '5',
      ]);
    });

    it('un rango de más de dos meses va por mes', () => {
      // «Este año» en septiembre: 264 días no caben en 430 px.
      const anio = armar(
        [
          f('A', 'FV-1', '2026-03-10', 5_000_000, 0),
          f('B', 'FV-2', '2026-03-20', 4_000_000, 0),
          f('C', 'FV-3', '2026-07-01', 2_000_000, 0),
        ],
        { desde: '2026-01-01', hasta: '2026-09-21' },
      );
      expect(anio.escala).toBe('MES');
      expect(anio.porDia.map((d) => d.rotulo)).toEqual([
        'ene',
        'feb',
        'mar',
        'abr',
        'may',
        'jun',
        'jul',
        'ago',
        'sep',
      ]);
      expect(anio.pico?.clave).toBe('2026-03');
      expect(anio.pico?.texto).toBe('mayor en mar 2026 · 9,0 M');
    });
  });

  describe('los bordes', () => {
    it('sin facturas no se cae, y lo dice', () => {
      const vacio = armar([], RANGO);
      expect(vacio.grupos).toEqual([]);
      expect(vacio.resumen.totalFacturado).toBe('$ 0');
      expect(vacio.resumen.cobradoPorciento).toBe(0);
      expect(vacio.pico).toBeNull();
      expect(vacio.resumen.vencidoDetalle).toBe('sin facturas vencidas');
    });

    it('una factura en cero no divide por cero', () => {
      const cero = armar([f('Cliente', 'FV-1', '2026-09-10', 0, 0)], RANGO);
      expect(cero.grupos[0].cobradoPorciento).toBe(0);
      expect(cero.grupos[0].facturas[0].situacion).toBe('PAGADA');
    });

    it('un pago mayor que el total no deja saldo negativo', () => {
      // Pasa con una nota crédito mal aplicada, y un «por cobrar: -$ 50.000»
      // en una hoja firmada es peor que un cero.
      const sobrepago = armar(
        [f('Cliente', 'FV-1', '2026-09-10', 100_000, 150_000)],
        RANGO,
      );
      expect(sobrepago.grupos[0].porCobrar).toBe('$ 0');
    });
  });

  describe('el formato colombiano', () => {
    it('escribe los miles con punto', () => {
      expect(pesos(68_575_000_00)).toBe('$ 68.575.000');
    });

    it('y los millones con coma decimal', () => {
      expect(millones(41_085_000_00)).toBe('41,1 M');
    });

    it('suma en centavos, no en decimales', () => {
      // Tres veces 0,10 son 0,30 exactos. Con `number` daría 0,30000000000000004
      // y, redondeado a pesos, el total general dejaría de cuadrar con la suma
      // de los grupos por un peso — sin que nada falle.
      const tres = armar(
        ['0.10', '0.10', '0.10'].map((v, i) => ({
          cliente: 'Cliente',
          clienteDocumento: '1',
          numero: `FV-${i}`,
          fecha: '2026-09-10',
          estado: 'EMITIDA' as const,
          total: v,
          pagado: '0.00',
        })),
        RANGO,
      );
      expect(tres.grupos[0].centavos).toBe(30);
    });
  });
});
