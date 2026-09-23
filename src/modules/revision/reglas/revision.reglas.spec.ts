import {
  asientosDescuadrados,
  documentosYAsientos,
  kardexDeAnulados,
  comprasDuplicadas,
  dosLados,
  dvNit,
  fecha,
  ivaAntesDelRegimen,
  mismosTerceros,
  movimientosRepetidos,
  numeroComparable,
  ordenar,
  periodosDistintos,
  pesos,
  tercerosDuplicados,
  type FilaCompra,
  type FilaDosLados,
  type FilaTercero,
} from './revision.reglas';

describe('pesos y fechas, como los lee una persona', () => {
  it('pesos con punto de miles y sin decimales vacíos', () => {
    expect(pesos(1234567)).toBe('$ 1.234.567');
    expect(pesos(681205.67)).toBe('$ 681.205,67');
    expect(pesos(-125347.47)).toBe('-$ 125.347,47');
  });

  it('fechas en dd/mm/aaaa', () => {
    expect(fecha('2026-07-28')).toBe('28/07/2026');
  });
});

describe('asientosDescuadrados — la red de abajo', () => {
  const asiento = {
    id: 'a1',
    numero: 'CC-12',
    fecha: '2026-09-01',
    totalDebito: 100,
    totalCredito: 100,
    sumaDebito: 100,
    sumaCredito: 100,
  };

  it('uno que cuadra no dice nada', () => {
    expect(asientosDescuadrados([asiento])).toEqual([]);
  });

  it('líneas que no suman lo de la cabecera', () => {
    const [h] = asientosDescuadrados([{ ...asiento, sumaCredito: 90 }]);
    expect(h).toMatchObject({
      tipo: 'ASIENTO_DESCUADRADO',
      grupo: 'DESCUADRE',
    });
    expect(h.titulo).toContain('CC-12');
  });
});

describe('periodosDistintos — un cierre que ya no coincide', () => {
  it('dice el período, la cuenta y las dos cifras', () => {
    const [h] = periodosDistintos([
      {
        periodoId: 'p8',
        anio: 2026,
        mes: 8,
        cuentaId: 'c1',
        cuentaCodigo: '110505',
        cuentaNombre: 'Caja general',
        congeladoDebitos: 1000,
        congeladoCreditos: 0,
        debitos: 1200,
        creditos: 0,
      },
    ]);
    expect(h.titulo).toBe(
      'El cierre de 08/2026 no coincide con sus asientos en la 110505',
    );
    expect(h.cifras).toEqual({ uno: 1000, otro: 1200, diferencia: -200 });
  });

  it('igual al centavo no dice nada', () => {
    expect(
      periodosDistintos([
        {
          periodoId: 'p8',
          anio: 2026,
          mes: 8,
          cuentaId: 'c1',
          cuentaCodigo: '110505',
          cuentaNombre: 'Caja',
          congeladoDebitos: 1000,
          congeladoCreditos: 5,
          debitos: 1000.004,
          creditos: 5,
        },
      ]),
    ).toEqual([]);
  });
});

describe('dosLados — el auxiliar contra su cuenta', () => {
  const inventario = (cambios: Partial<FilaDosLados> = {}): FilaDosLados => ({
    cuentaId: 'c1435',
    cuentaCodigo: '143501',
    cuentaNombre: 'Mercancías',
    auxiliar: 45_741_691.99,
    contable: 13_297_039.46,
    sinAsiento: 32_570_000,
    nombres: [{ id: 'p1', nombre: 'TINTA' }],
    ...cambios,
  });

  // El caso real de la base de pruebas: casi todo es el saldo inicial, pero
  // no todo, y lo que sobra es lo que hay que ir a buscar.
  it('separa lo que explica el saldo inicial de lo que no', () => {
    const [h] = dosLados('INVENTARIO_VS_CONTABILIDAD', [inventario()]);
    expect(h.detalle).toContain(
      '$ 32.570.000 son saldos iniciales de inventario',
    );
    expect(h.detalle).toContain(
      'Los otros -$ 125.347,47 no se explican por ahí.',
    );
  });

  it('cuando es exactamente el saldo inicial, lo dice así', () => {
    const [h] = dosLados('INVENTARIO_VS_CONTABILIDAD', [
      inventario({ auxiliar: 1_000, contable: 400, sinAsiento: 600 }),
    ]);
    expect(h.detalle).toContain('Con eso se explica toda la diferencia');
  });

  it('una caja que da igual que su cuenta no dice nada', () => {
    expect(
      dosLados('CAJA_VS_CONTABILIDAD', [
        inventario({ auxiliar: 500, contable: 500, sinAsiento: 0 }),
      ]),
    ).toEqual([]);
  });

  it('la caja se nombra y queda como referencia', () => {
    const [h] = dosLados('CAJA_VS_CONTABILIDAD', [
      inventario({
        cuentaCodigo: '110505',
        auxiliar: 500,
        contable: 300,
        sinAsiento: 0,
        nombres: [{ id: 'caja1', nombre: 'Caja Principal' }],
      }),
    ]);
    expect(h.detalle).toContain('Caja Principal');
    expect(h.referencias).toContainEqual({
      tipo: 'CAJA',
      id: 'caja1',
      etiqueta: 'Caja Principal',
    });
  });
});

describe('terceros — el mismo documento, escrito distinto', () => {
  const t = (
    id: string,
    tipoDocumento: string,
    numeroDocumento: string,
    dv: string | null = null,
  ): FilaTercero => ({ id, tipoDocumento, numeroDocumento, dv, nombre: id });

  it('el dígito de verificación de la DIAN', () => {
    expect(dvNit('900378652')).toBe(dvNit('900.378.652'));
    expect(dvNit('70107435')).toBe('6');
  });

  // Los dos casos que aparecieron en la base de pruebas.
  it('la misma persona como cédula y como NIT', () => {
    const grupos = mismosTerceros([
      t('nit', 'NIT', '70107435', '6'),
      t('cc', 'CC', '70107435'),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].map((x) => x.id).sort()).toEqual(['cc', 'nit']);
  });

  it('con puntos o sin ellos', () => {
    expect(
      mismosTerceros([t('a', 'NIT', '900.378.652'), t('b', 'CC', '900378652')]),
    ).toHaveLength(1);
  });

  it('con el dígito de verificación pegado, solo si de verdad es el suyo', () => {
    const dv = dvNit('900378652');
    const otro = String((Number(dv) + 1) % 10);
    expect(
      mismosTerceros([
        t('a', 'NIT', '900378652', dv),
        t('b', 'NIT', `900378652${dv}`),
      ]),
    ).toHaveLength(1);
    expect(
      mismosTerceros([
        t('a', 'NIT', '900378652', dv),
        t('b', 'NIT', `900378652${otro}`),
      ]),
    ).toEqual([]);
  });

  it('números distintos no se juntan', () => {
    expect(
      mismosTerceros([t('a', 'CC', '70107435'), t('b', 'CC', '70107436')]),
    ).toEqual([]);
  });

  it('el hallazgo nombra las dos formas', () => {
    const [h] = tercerosDuplicados(
      mismosTerceros([
        t('nit', 'NIT', '70107435', '6'),
        t('cc', 'CC', '70107435'),
      ]),
    );
    expect(h.titulo).toContain('dos veces');
    expect(h.detalle).toContain('NIT 70107435-6');
    expect(h.detalle).toContain('CC 70107435');
  });
});

describe('comprasDuplicadas — la misma factura dos veces', () => {
  const compra = (
    id: string,
    terceroId: string,
    numero: string,
  ): FilaCompra => ({
    id,
    terceroId,
    proveedor: 'JALTECH',
    numero,
    fecha: '2026-07-28',
    total: 100,
  });

  it('el número escrito de cualquier forma', () => {
    expect(numeroComparable('FE-0123')).toBe('FE123');
    expect(numeroComparable('fe 123')).toBe('FE123');
    expect(numeroComparable('000215183')).toBe('215183');
  });

  it('el mismo número con otro formato, del mismo proveedor', () => {
    const [h] = comprasDuplicadas(
      [compra('1', 'p', 'FE-0123'), compra('2', 'p', 'FE123')],
      [],
    );
    expect(h.tipo).toBe('COMPRA_DUPLICADA');
    expect(h.referencias.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('el mismo número de dos proveedores distintos no es duplicado', () => {
    expect(
      comprasDuplicadas([compra('1', 'p', '123'), compra('2', 'q', '123')], []),
    ).toEqual([]);
  });

  // La que se escapa del índice único de la base: dos terceros que son el mismo.
  it('la misma factura cargada a dos terceros que son la misma persona', () => {
    const mismos: FilaTercero[][] = [
      [
        {
          id: 'p',
          tipoDocumento: 'NIT',
          numeroDocumento: '1',
          dv: null,
          nombre: 'X',
        },
        {
          id: 'q',
          tipoDocumento: 'CC',
          numeroDocumento: '1',
          dv: null,
          nombre: 'X',
        },
      ],
    ];
    expect(
      comprasDuplicadas(
        [compra('1', 'p', '123'), compra('2', 'q', '123')],
        mismos,
      ),
    ).toHaveLength(1);
  });
});

describe('movimientosRepetidos — cobros y pagos idénticos', () => {
  it('un cobro dos veces', () => {
    const [h] = movimientosRepetidos([
      {
        origenTipo: 'FACTURA_VENTA',
        origenId: 'v1',
        documento: 'FV-10',
        tercero: 'Papelería Central',
        fecha: '2026-09-10',
        valor: 50_000,
        movimientos: [
          { id: 'm1', medio: 'Caja Principal' },
          { id: 'm2', medio: 'Caja Principal' },
        ],
      },
    ]);
    expect(h).toMatchObject({ tipo: 'COBRO_DUPLICADO', grupo: 'DUPLICADO' });
    expect(h.titulo).toBe('El cobro de la factura FV-10 está dos veces');
    expect(h.detalle).toContain('el de Caja Principal');
    expect(h.cifras?.diferencia).toBe(50_000);
  });

  it('un pago dos veces', () => {
    const [h] = movimientosRepetidos([
      {
        origenTipo: 'COMPRA',
        origenId: 'c1',
        documento: '215183',
        tercero: 'JALTECH',
        fecha: '2026-09-10',
        valor: 10,
        movimientos: [
          { id: 'm1', medio: 'Caja Principal' },
          { id: 'm2', medio: 'Bancolombia 123' },
        ],
      },
    ]);
    expect(h.tipo).toBe('PAGO_DUPLICADO');
    expect(h.detalle).toContain('la caja o el banco');
  });
});

describe('ivaAntesDelRegimen — dos cosas que no pueden ser ciertas a la vez', () => {
  const fila = (compraId: string, fechaCompra: string, iva: number) => ({
    compraId,
    numero: compraId,
    proveedor: 'JALTECH',
    fecha: fechaCompra,
    ivaAlCosto: iva,
    regimenDesde: '2026-09-20',
  });

  it('una sola compra se dice sola', () => {
    const [h] = ivaAntesDelRegimen([fila('215183', '2026-07-28', 681_205.67)]);
    expect(h.titulo).toBe(
      'El IVA de la factura 215183 de JALTECH se fue al costo',
    );
    expect(h.detalle).toContain('28/07/2026');
    expect(h.detalle).toContain('las dos cosas no pueden ser ciertas a la vez');
  });

  // Todas antes de la misma fecha son una sola causa: se arregla una vez.
  it('varias compras antes de la misma fecha son un solo hallazgo, con el total', () => {
    const h = ivaAntesDelRegimen([
      fila('b', '2026-08-01', 200),
      fila('a', '2026-07-01', 100),
    ]);
    expect(h).toHaveLength(1);
    expect(h[0].titulo).toBe('El IVA de 2 compras se fue al costo: $ 300');
    expect(h[0].referencias.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('sin IVA al costo no hay nada que decir', () => {
    expect(ivaAntesDelRegimen([fila('x', '2026-07-01', 0)])).toEqual([]);
  });
});

describe('ordenar', () => {
  it('primero lo que no debería poder pasar', () => {
    const tercero = tercerosDuplicados([
      [
        {
          id: 'a',
          tipoDocumento: 'CC',
          numeroDocumento: '1',
          dv: null,
          nombre: 'X',
        },
        {
          id: 'b',
          tipoDocumento: 'NIT',
          numeroDocumento: '1',
          dv: null,
          nombre: 'X',
        },
      ],
    ]);
    const asiento = asientosDescuadrados([
      {
        id: 'x',
        numero: 'CC-1',
        fecha: '2026-01-01',
        totalDebito: 1,
        totalCredito: 1,
        sumaDebito: 1,
        sumaCredito: 0,
      },
    ]);
    expect(ordenar([...tercero, ...asiento]).map((h) => h.tipo)).toEqual([
      'ASIENTO_DESCUADRADO',
      'TERCERO_DUPLICADO',
    ]);
  });
});

describe('dosLados — con lo que dejaron las anulaciones', () => {
  // El caso real: saldo inicial sin asiento, más dos anulaciones que no
  // dejaron el kardex en cero, explican la diferencia entera.
  it('descuenta las anulaciones y dice que con eso cierra', () => {
    const [h] = dosLados('INVENTARIO_VS_CONTABILIDAD', [
      {
        cuentaId: 'c',
        cuentaCodigo: '143501',
        cuentaNombre: 'Mercancías',
        auxiliar: 45_533_641.99,
        contable: 13_297_039.46,
        sinAsiento: 32_570_000,
        porAnulaciones: -333_397.5,
        nombres: [],
      },
    ]);
    expect(h.detalle).toContain('-$ 333.397,50 salen de documentos anulados');
    // Tres centavos de redondeo del promedio no son una diferencia.
    expect(h.detalle).toContain('Con eso se explica toda la diferencia.');
  });
});

describe('kardexDeAnulados — lo anulado tiene que dejar el kardex en cero', () => {
  it('una venta anulada que no devolvió la mercancía', () => {
    const [h] = kardexDeAnulados([
      {
        asientoId: 'a',
        documento: 'la factura de venta SETT-13',
        entradas: 0,
        salidas: 208_050,
      },
    ]);
    expect(h.titulo).toBe(
      'Anular la factura de venta SETT-13 no devolvió la mercancía al kardex',
    );
    expect(h.certeza).toBe('AFIRMADO');
    expect(h.cifras?.diferencia).toBe(-208_050);
  });

  it('una compra anulada que sacó más de lo que entró', () => {
    const [h] = kardexDeAnulados([
      {
        asientoId: 'a',
        documento: 'la compra 101264',
        entradas: 1_131_573,
        salidas: 1_256_920.5,
      },
    ]);
    expect(h.detalle).toContain('quedó $ 125.347,50 por debajo');
  });

  it('una anulación bien hecha no dice nada', () => {
    expect(
      kardexDeAnulados([
        { asientoId: 'a', documento: 'x', entradas: 100, salidas: 100 },
      ]),
    ).toEqual([]);
  });
});

describe('documentosYAsientos — el documento y su asiento tienen que decir lo mismo', () => {
  it('vigente con el asiento anulado', () => {
    const [h] = documentosYAsientos([
      {
        tipo: 'VENTA',
        id: 'v',
        numero: 'SETT-9',
        estadoDocumento: 'EMITIDA',
        estadoAsiento: 'ANULADO',
      },
    ]);
    expect(h.titulo).toBe(
      'La factura de venta SETT-9 está vigente y su asiento, anulado',
    );
  });

  it('anulada con el asiento vigente', () => {
    const [h] = documentosYAsientos([
      {
        tipo: 'COMPRA',
        id: 'c',
        numero: '123',
        estadoDocumento: 'ANULADA',
        estadoAsiento: 'REGISTRADO',
      },
    ]);
    expect(h.detalle).toContain('sigue en los libros');
  });
});
