import {
  balanceGeneral,
  clasificar,
  estadoDeResultados,
  flujoDirecto,
  flujoProyectado,
  lunesDe,
  margen,
  mesDe,
  mesesHasta,
  resultadoDe,
  variacion,
  resultadosPorCentro,
} from './estados.reglas';

const mov = (
  codigo: string,
  debito: number,
  credito: number,
  nombre = codigo,
) => ({
  codigo,
  nombre,
  debito,
  credito,
});

describe('estado de resultados', () => {
  // Los números del lienzo de septiembre.
  const movs = [
    mov('413595', 0, 35_120_000, 'Venta de mercancía'),
    mov('415595', 0, 6_730_000, 'Servicios'),
    mov('613595', 21_180_000, 0),
    mov('510506', 12_000_000, 0),
    mov('511595', 450_300, 0), // el 4×1000 va a administración (D8)
    mov('523560', 1_654_000, 0),
    mov('421005', 0, 330_000),
    mov('530520', 628_000, 0),
  ];

  it('cuadra con el lienzo', () => {
    const e = estadoDeResultados(movs);
    expect(e.ingresosOperacionales).toBe(41_850_000);
    expect(e.utilidadBruta).toBe(20_670_000);
    expect(e.utilidadOperacional).toBe(6_565_700);
    expect(e.utilidadAntesDeImpuestos).toBe(6_267_700);
    expect(e.renglones.find((r) => r.clave === 'admin')?.valor).toBe(
      12_450_300,
    );
    // Sin impuesto de renta no hay renglón de utilidad neta.
    expect(e.renglones.some((r) => r.clave === 'neta')).toBe(false);
  });

  it('trae el detalle por cuenta, de mayor a menor', () => {
    const ingresos = estadoDeResultados(movs).renglones[0];
    expect(ingresos.cuentas?.map((c) => c.nombre)).toEqual([
      'Venta de mercancía',
      'Servicios',
    ]);
  });

  it('una devolución en ventas resta de los ingresos', () => {
    const e = estadoDeResultados([
      mov('413595', 100, 1_000),
      mov('417505', 50, 0),
    ]);
    expect(e.ingresosOperacionales).toBe(850);
  });

  it('márgenes y variación', () => {
    expect(margen(20_670_000, 41_850_000)).toBe(49.4);
    expect(margen(1, 0)).toBeNull();
    expect(variacion(6_267_700, 5_359_900)).toBe(16.9);
    expect(variacion(-50, -100)).toBe(50);
  });
});

describe('balance general', () => {
  const saldos = [
    { codigo: '110505', nombre: 'Caja general', saldo: 1_000 },
    { codigo: '111005', nombre: 'Bancos', saldo: 4_000 },
    { codigo: '130505', nombre: 'Clientes', saldo: 3_000 },
    { codigo: '152405', nombre: 'Equipo de oficina', saldo: 2_000 },
    { codigo: '220505', nombre: 'Proveedores', saldo: -2_500 },
    { codigo: '236540', nombre: 'Retención compras', saldo: -500 },
    { codigo: '311505', nombre: 'Aportes sociales', saldo: -5_000 },
    // Resultados sin cerrar: ingresos 5.000, gastos 3.000 → utilidad 2.000.
    { codigo: '413595', nombre: 'Ventas', saldo: -5_000 },
    { codigo: '510506', nombre: 'Sueldos', saldo: 3_000 },
  ];

  it('cuadra con el resultado sin cerrar en el patrimonio', () => {
    const b = balanceGeneral(saldos, {
      ejercicio: resultadoDe(saldos),
      anteriores: 0,
    });
    expect(b.activo.total).toBe(10_000);
    expect(b.pasivo.total).toBe(3_000);
    expect(b.patrimonio.total).toBe(7_000);
    expect(b.diferencia).toBe(0);
    expect(b.activo.secciones.map((s) => s.etiqueta)).toEqual([
      'Activo corriente',
      'Activo no corriente',
    ]);
    expect(b.activo.secciones[0].renglones.map((r) => r.etiqueta)).toEqual([
      'Disponible',
      'Deudores',
    ]);
    expect(b.patrimonio.secciones[0].renglones.at(-1)?.etiqueta).toMatch(
      /Resultado del ejercicio/,
    );
  });

  it('si el libro no cuadra, lo dice', () => {
    const b = balanceGeneral(saldos.slice(0, 7), {
      ejercicio: 0,
      anteriores: 0,
    });
    expect(b.diferencia).toBe(2_000);
  });
});

describe('flujo de caja directo', () => {
  it('el concepto manda; si no hay, la cuenta contraria', () => {
    expect(
      clasificar({
        netoCaja: -1_000,
        contrapartidas: [
          {
            codigo: '530520',
            neto: 1_000,
            concepto: { nombre: 'Intereses', tipoFlujo: 'FINANCIACION' },
          },
        ],
      }),
    ).toEqual({ actividad: 'FINANCIACION', rubro: 'Intereses' });
    expect(
      clasificar({
        netoCaja: 500,
        contrapartidas: [{ codigo: '130505', neto: -500, concepto: null }],
      }),
    ).toEqual({
      actividad: 'OPERACION',
      rubro: 'Cobros a clientes',
    });
    expect(
      clasificar({
        netoCaja: 500,
        contrapartidas: [{ codigo: '999999', neto: -500, concepto: null }],
      }).rubro,
    ).toBe('Sin clasificar');
  });

  it('suma por actividad, deja afuera los traslados y cuadra con el libro', () => {
    const f = flujoDirecto(
      [
        {
          netoCaja: 3_000,
          contrapartidas: [{ codigo: '130505', neto: -3_000, concepto: null }],
        },
        {
          netoCaja: -1_200,
          contrapartidas: [{ codigo: '220505', neto: 1_200, concepto: null }],
        },
        {
          netoCaja: -800,
          contrapartidas: [{ codigo: '210505', neto: 800, concepto: null }],
        },
        { netoCaja: 0, contrapartidas: [] }, // un traslado: D banco / C caja
      ],
      10_000,
      11_000,
    );
    expect(
      f.actividades.map((a) => [a.actividad, a.entradas, a.salidas]),
    ).toEqual([
      ['OPERACION', 3_000, 1_200],
      ['FINANCIACION', 0, 800],
    ]);
    expect(f.neto).toBe(1_000);
    expect(f.diferencia).toBe(0);
  });
});

describe('flujo de caja proyectado', () => {
  it('pone cada compromiso en su semana, con lo vencido aparte', () => {
    expect(lunesDe('2026-09-28')).toBe('2026-09-28');
    expect(lunesDe('2026-10-04')).toBe('2026-09-28');
    const s = flujoProyectado({
      hoy: '2026-09-30',
      disponible: 1_000,
      porCobrar: [
        { fecha: '2026-09-10', valor: 200 }, // vencida
        { fecha: '2026-10-02', valor: 500 }, // esta semana
        { fecha: '2026-10-06', valor: 300 }, // la próxima
        { fecha: '2027-01-01', valor: 999 }, // fuera del horizonte
      ],
      porPagar: [{ fecha: '2026-10-07', valor: 1_500 }],
      semanas: 3,
    });
    expect(s.map((x) => [x.etiqueta, x.entradas, x.salidas, x.saldo])).toEqual([
      ['Vencido', 200, 0, 1_200],
      ['Esta semana', 500, 0, 1_700],
      ['5/10 – 11/10', 300, 1_500, 500],
      ['12/10 – 18/10', 0, 0, 500],
    ]);
  });
});

describe('períodos', () => {
  it('el mes, su último día y los anteriores', () => {
    expect(mesDe('2026-02')).toEqual({
      desde: '2026-02-01',
      hasta: '2026-02-28',
      anterior: '2026-01',
    });
    expect(mesesHasta('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});

describe('resultadosPorCentro', () => {
  const centros = [
    { id: 'n', codigo: 'N', nombre: 'Norte', tipo: 'PRODUCTIVO' as const },
    { id: 's', codigo: 'S', nombre: 'Sur', tipo: 'PRODUCTIVO' as const },
    {
      id: 'a',
      codigo: 'A',
      nombre: 'Administración',
      tipo: 'ADMINISTRATIVO' as const,
    },
  ];
  const movs = [
    {
      codigo: '413505',
      nombre: 'Ventas',
      debito: 0,
      credito: 1000,
      centroId: 'n',
    },
    {
      codigo: '413505',
      nombre: 'Ventas',
      debito: 0,
      credito: 600,
      centroId: 's',
    },
    {
      codigo: '613505',
      nombre: 'Costo',
      debito: 400,
      credito: 0,
      centroId: 'n',
    },
    {
      codigo: '510506',
      nombre: 'Sueldos',
      debito: 300,
      credito: 0,
      centroId: 'a',
    },
    {
      codigo: '519530',
      nombre: 'Útiles',
      debito: 50,
      credito: 0,
      centroId: null,
    },
  ];

  it('una columna por centro con movimiento, «Sin centro» al final, y suman el total', () => {
    const { columnas, total } = resultadosPorCentro(movs, centros, 'CENTRO');
    expect(columnas.map((c) => c.clave)).toEqual(['n', 's', 'a', 'SIN_CENTRO']);
    const suma = columnas.reduce(
      (s, c) => s + c.estado.utilidadAntesDeImpuestos,
      0,
    );
    expect(suma).toBeCloseTo(total.utilidadAntesDeImpuestos);
    expect(columnas[0].estado.utilidadBruta).toBe(600);
  });

  it('agrupado por tipo: productivos juntos', () => {
    const { columnas } = resultadosPorCentro(movs, centros, 'TIPO');
    expect(columnas.map((c) => c.clave)).toEqual([
      'PRODUCTIVO',
      'ADMINISTRATIVO',
      'SIN_CENTRO',
    ]);
    expect(columnas[0].estado.ingresosOperacionales).toBe(1600);
  });

  it('un centro que no viene en la lista cae en «Sin centro» y no se pierde', () => {
    const { columnas, total } = resultadosPorCentro(
      [
        {
          codigo: '519530',
          nombre: 'Útiles',
          debito: 80,
          credito: 0,
          centroId: 'x',
        },
      ],
      centros,
      'CENTRO',
    );
    expect(columnas.map((c) => c.clave)).toEqual(['SIN_CENTRO']);
    expect(columnas[0].estado.utilidadAntesDeImpuestos).toBe(
      total.utilidadAntesDeImpuestos,
    );
  });
});
