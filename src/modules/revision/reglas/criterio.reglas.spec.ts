import {
  comprasParecidas,
  comprasSinRetencion,
  gastosAInventario,
  gastosEnCuentaDistinta,
  lecturasSinRegistrar,
  periodosSinCerrar,
  productosSinDatosDeVenta,
  tercerosSinMarcar,
  type FilaCompraParecida,
  type FilaGasto,
  type FilaLectura,
} from './criterio.reglas';

/** Lo que no puede faltar nunca en un hallazgo de criterio. */
const esCriterio = (h: { certeza: string; detalle: string }) => {
  expect(['VISTA', 'DEDUCIDA']).toContain(h.certeza);
  expect(h.detalle).toContain('Me parece');
  expect(h.detalle).not.toMatch(/está mal\b/);
};

describe('comprasSinRetencion', () => {
  const compra = (numero: string) => ({
    compraId: numero,
    numero,
    proveedor: 'PAPELERIA',
    fecha: '2026-09-22',
    subtotal: 2_000_000,
  });

  // El caso real: agente retenedor desde el 20 de septiembre y sin un solo
  // concepto de renta configurado. Es una causa, y se dice una vez.
  it('sin conceptos configurados: un solo hallazgo, visto, con todas', () => {
    const h = comprasSinRetencion(
      [
        {
          anio: 2026,
          desde: '2026-09-20',
          compras: [compra('A'), compra('B')],
        },
      ],
      [],
    );
    expect(h).toHaveLength(1);
    expect(h[0].certeza).toBe('VISTA');
    expect(h[0].titulo).toContain('no tiene conceptos de retención para 2026');
    expect(h[0].detalle).toContain(
      'las 2 compras desde esa fecha salieron sin retención',
    );
    esCriterio(h[0]);
  });

  it('con conceptos, la que supera la base se deduce', () => {
    const [h] = comprasSinRetencion([], [compra('C')]);
    expect(h.certeza).toBe('DEDUCIDA');
    expect(h.detalle).toContain('salvo que el proveedor sea autorretenedor');
    esCriterio(h);
  });
});

describe('periodosSinCerrar', () => {
  it('un mes que terminó hace más de 30 días', () => {
    const [h] = periodosSinCerrar([
      { periodoId: 'p7', anio: 2026, mes: 7, diasDesdeElFin: 54 },
      { periodoId: 'p8', anio: 2026, mes: 8, diasDesdeElFin: 23 },
    ]);
    expect(h.titulo).toBe('Julio de 2026 sigue abierto');
    expect(h.referencias.map((r) => r.id)).toEqual(['p7']);
    esCriterio(h);
  });

  it('el mes pasado todavía se está cerrando: nada', () => {
    expect(
      periodosSinCerrar([
        { periodoId: 'p8', anio: 2026, mes: 8, diasDesdeElFin: 23 },
      ]),
    ).toEqual([]);
  });
});

describe('lecturasSinRegistrar', () => {
  const lectura = (
    id: string,
    cambios: Partial<FilaLectura> = {},
  ): FilaLectura => ({
    id,
    tipo: 'FACTURA_COMPRA',
    tercero: 'OMAIRA VASQUEZ HENAO',
    nit: '43000000',
    numero: null,
    fechaDocumento: '2026-08-31',
    total: 1_500_000,
    registradaComo: null,
    diasDesdeLaLectura: 0,
    ...cambios,
  });

  // El caso real: la misma cuenta de cobro, subida cuatro veces.
  it('la misma factura leída varias veces, y una ya registrada', () => {
    const [h] = lecturasSinRegistrar([
      lectura('1', { registradaComo: 'CC-0924' }),
      lectura('2'),
      lectura('3'),
      lectura('4'),
    ]);
    expect(h.titulo).toBe('La factura de OMAIRA VASQUEZ HENAO se leyó 4 veces');
    expect(h.detalle).toContain('ya se registró como CC-0924');
    expect(h.referencias.map((r) => r.id)).toEqual(['2', '3', '4']);
    esCriterio(h);
  });

  it('una sola, reciente y sin registrar: todavía no se pregunta', () => {
    expect(
      lecturasSinRegistrar([lectura('1', { diasDesdeLaLectura: 1 })]),
    ).toEqual([]);
  });

  it('una sola, vieja y sin registrar: se pregunta', () => {
    const [h] = lecturasSinRegistrar([
      lectura('1', { diasDesdeLaLectura: 10 }),
    ]);
    expect(h.titulo).toContain('hace 10 días y sin registrar');
  });

  it('documentos distintos no se juntan', () => {
    expect(
      lecturasSinRegistrar([
        lectura('1', { registradaComo: 'CC-0924' }),
        lectura('2', { total: 999 }),
      ]),
    ).toEqual([]);
  });
});

describe('productosSinDatosDeVenta', () => {
  it('solo los que tienen existencias, en un solo hallazgo', () => {
    const [h] = productosSinDatosDeVenta([
      {
        id: '1',
        codigo: 'A',
        nombre: 'TECLADO',
        existencias: 3,
        sinPrecio: true,
        sinCuentas: false,
      },
      {
        id: '2',
        codigo: 'B',
        nombre: 'MOUSE',
        existencias: 0,
        sinPrecio: true,
        sinCuentas: false,
      },
    ]);
    expect(h.titulo).toBe('1 producto con existencias no se puede facturar');
    expect(h.referencias.map((r) => r.id)).toEqual(['1']);
    esCriterio(h);
  });
});

describe('tercerosSinMarcar', () => {
  it('con compras y sin marcar como proveedor', () => {
    const [h] = tercerosSinMarcar([
      { id: 't', nombre: 'JALTECH', falta: 'PROVEEDOR', documentos: 2 },
    ]);
    expect(h.titulo).toBe(
      '«JALTECH» tiene 2 compras vigentes y no figura como proveedor',
    );
    esCriterio(h);
  });
});

describe('gastos', () => {
  const gasto = (
    numero: string,
    cuentaId: string,
    cambios: Partial<FilaGasto> = {},
  ): FilaGasto => ({
    compraId: numero,
    numero,
    terceroId: 'omaira',
    proveedor: 'OMAIRA',
    detalle: 'ARRIENDO',
    cuentaId,
    cuenta: cuentaId === 'c512' ? '512005 Arrendamientos' : '519595 Otros',
    total: 1_500_000,
    esCuentaDeInventario: false,
    ...cambios,
  });

  it('un gasto a una cuenta distinta de la de siempre del mismo proveedor', () => {
    const [h] = gastosEnCuentaDistinta([
      gasto('1', 'c512'),
      gasto('2', 'c512'),
      gasto('3', 'c519'),
    ]);
    expect(h.certeza).toBe('DEDUCIDA');
    expect(h.detalle).toContain('quedó en 519595 Otros');
    expect(h.detalle).toContain('van a 512005 Arrendamientos');
    esCriterio(h);
  });

  it('sin una costumbre —una vez cada una— no hay «distinta»', () => {
    expect(
      gastosEnCuentaDistinta([gasto('1', 'c512'), gasto('2', 'c519')]),
    ).toEqual([]);
  });

  it('un gasto a la cuenta del inventario', () => {
    const [h] = gastosAInventario([
      gasto('9', 'c1435', {
        esCuentaDeInventario: true,
        cuenta: '143501 Mercancías',
        total: 50_000,
      }),
    ]);
    expect(h.titulo).toContain('sin pasar por el kardex: $ 50.000');
    esCriterio(h);
  });
});

describe('comprasParecidas', () => {
  const compra = (
    id: string,
    numero: string,
    fecha: string,
    cambios: Partial<FilaCompraParecida> = {},
  ): FilaCompraParecida => ({
    id,
    terceroId: 'omaira',
    proveedor: 'OMAIRA',
    numero,
    fecha,
    total: 1_500_000,
    ...cambios,
  });

  // El caso real: el arriendo de agosto con dos números distintos.
  it('mismo proveedor, mismo total, pocos días, números distintos', () => {
    const [h] = comprasParecidas(
      [
        compra('a', 'CC-0831', '2026-08-31'),
        compra('b', 'CC-0924', '2026-08-31'),
      ],
      [],
    );
    expect(h.titulo).toBe(
      'Dos compras de OMAIRA por $ 1.500.000 con 0 días de diferencia',
    );
    esCriterio(h);
  });

  it('un mes de diferencia es el arriendo del mes siguiente', () => {
    expect(
      comprasParecidas(
        [compra('a', '1', '2026-08-31'), compra('b', '2', '2026-09-30')],
        [],
      ),
    ).toEqual([]);
  });

  it('el mismo número escrito distinto lo dice la fase 7, no acá', () => {
    expect(
      comprasParecidas(
        [compra('a', 'FE-01', '2026-08-31'), compra('b', 'FE1', '2026-08-31')],
        [],
      ),
    ).toEqual([]);
  });

  it('otro proveedor no se parece', () => {
    expect(
      comprasParecidas(
        [
          compra('a', '1', '2026-08-31'),
          compra('b', '2', '2026-08-31', { terceroId: 'otro' }),
        ],
        [],
      ),
    ).toEqual([]);
  });
});
