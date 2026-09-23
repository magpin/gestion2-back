import type { CtxEmpresa } from '../../../common/ctx';
import type { InventarioApi } from '../../inventario/inventario.api';
import type { NucleoApi } from '../../nucleo/nucleo.api';
import {
  comprobar,
  type FacturaCompraLeida,
} from '../reglas/factura-compra.reglas';
import { CruceService } from './cruce.service';
import type { MemoriaService, Recordado } from './memoria.service';
import type { PedidoLeido } from '../reglas/pedido-venta.reglas';

const ctx = { empresaId: 'e1', tenantId: 't1' } as unknown as CtxEmpresa;

const producto = (id: string, codigo: string, nombre: string) => ({
  id,
  codigo,
  nombre,
});

const tercero = (esProveedor = true) => ({
  id: 'prov-1',
  tipoDocumento: 'NIT',
  numeroDocumento: '900378652',
  dv: '1',
  nombre: 'JALTECH SOLUCIONES S.A.S.',
  esCliente: false,
  esProveedor,
  responsableIva: true,
  declaranteRenta: true,
  activo: true,
});

/** Lo que el cruce consulta —dos APIs y la memoria—, de mentira. */
const armar = (opciones: {
  terceros?: ReturnType<typeof tercero>[];
  productos?: Record<string, ReturnType<typeof producto>[]>;
  cuentas?: Record<
    string,
    { id: string; codigo: string; nombre: string; esAuxiliar: boolean }
  >;
  /** Por id, como las pide lo recordado. */
  cuentasPorId?: Record<
    string,
    {
      id: string;
      codigo: string;
      nombre: string;
      activa: boolean;
      es_auxiliar: boolean;
    }
  >;
  productosPorId?: Record<
    string,
    { id: string; codigo: string; nombre: string; activo: boolean }
  >;
  recordados?: Recordado[];
}) => {
  const productos = opciones.productos ?? {};
  const nucleo = {
    terceroPorDocumento: jest.fn().mockResolvedValue(opciones.terceros ?? []),
    cuenta: jest
      .fn()
      .mockImplementation((_c: unknown, codigo: string) =>
        Promise.resolve(opciones.cuentas?.[codigo] ?? null),
      ),
    cuentaPorId: jest
      .fn()
      .mockImplementation((_c: unknown, id: string) =>
        Promise.resolve(opciones.cuentasPorId?.[id] ?? null),
      ),
  } as unknown as NucleoApi;
  const inventario = {
    buscarProductos: jest
      .fn()
      .mockImplementation((_c: unknown, q: string) =>
        Promise.resolve(productos[q] ?? []),
      ),
    producto: jest
      .fn()
      .mockImplementation((_c: unknown, id: string) =>
        Promise.resolve(opciones.productosPorId?.[id] ?? null),
      ),
  } as unknown as InventarioApi;
  const recordados = jest
    .fn()
    .mockResolvedValue(
      new Map(
        (opciones.recordados ?? []).map((r) => [`${r.clase}|${r.texto}`, r]),
      ),
    );
  const memoria = { recordados } as unknown as MemoriaService;
  return {
    servicio: new CruceService(nucleo, inventario, memoria),
    nucleo,
    inventario,
    recordados,
  };
};

const factura = (
  cambios: Partial<FacturaCompraLeida> = {},
): FacturaCompraLeida => ({
  proveedor: { nombre: 'JALTECH SOLUCIONES S.A.S.', nit: '900378652' },
  numero: '215183',
  prefijo: null,
  fecha: '2026-07-28',
  renglones: [
    {
      codigo: 'P001',
      descripcion: 'TECLADO INALAMBRICO',
      clase: 'PRODUCTO',
      cuentaPuc: null,
      cantidad: 2,
      valorUnitario: 50_000,
      ivaTarifa: 19,
      total: 100_000,
    },
  ],
  impreso: { subtotal: 100_000, iva: 19_000, retencion: 0, total: 119_000 },
  ...cambios,
});

const cruzar = (servicio: CruceService, f: FacturaCompraLeida) =>
  servicio.cruzar(ctx, f, comprobar(f));

describe('CruceService — una factura completa', () => {
  it('resuelve proveedor y producto, y queda lista', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    const r = await cruzar(servicio, factura());

    expect(r.completa).toBe(true);
    expect(r.preguntas).toHaveLength(0);
    expect(r.proveedor?.id).toBe('prov-1');
    expect(r.lineas).toEqual([
      {
        productoId: 'prod-1',
        cantidad: 2,
        costoUnitario: 50_000,
        valor: 100_000,
      },
    ]);
  });

  // Dos búsquedas por renglón en una factura de sesenta serían ciento veinte
  // consultas: si el código resuelve, no se busca por nombre.
  it('no busca por nombre cuando el código ya resolvió', async () => {
    const { servicio, inventario } = armar({
      terceros: [tercero()],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    await cruzar(servicio, factura());

    expect(inventario.buscarProductos).toHaveBeenCalledTimes(1);
  });
});

describe('CruceService — lo que hay que preguntar', () => {
  it('un producto que no está en el catálogo no se inventa', async () => {
    const { servicio } = armar({ terceros: [tercero()], productos: {} });

    const r = await cruzar(servicio, factura());

    expect(r.completa).toBe(false);
    expect(r.preguntas).toHaveLength(1);
    expect(r.preguntas[0].sobre).toBe('renglon-1');
    expect(r.preguntas[0].texto).toContain('TECLADO INALAMBRICO');
  });

  it('un proveedor que no está se propone crear', async () => {
    const { servicio } = armar({
      terceros: [],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    const r = await cruzar(servicio, factura());

    expect(r.proveedor).toBeNull();
    expect(r.preguntas.map((p) => p.sobre)).toContain('proveedor');
  });

  // Es el caso real del arriendo: se leyó bien y no se pudo registrar.
  it('sin número de factura se pregunta cuál usar', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    const r = await cruzar(servicio, factura({ numero: null }));

    expect(r.completa).toBe(false);
    expect(r.preguntas.map((p) => p.sobre)).toContain('numero');
  });

  // Mandar media factura a POST /compras la registraría incompleta, que es
  // peor que no registrarla.
  it('cuando falta algo, no quedan líneas para registrar', async () => {
    const { servicio } = armar({ terceros: [], productos: {} });

    const r = await cruzar(servicio, factura());

    expect(r.lineas).toEqual([]);
    // Pero los renglones sí viajan: la pantalla los necesita para preguntar.
    expect(r.renglones).toHaveLength(1);
    expect(r.renglones[0].resuelto).toBeNull();
  });

  // Se pudo leer; lo que no dan son las cuentas. No se propone.
  it('una factura que no cuadra nunca queda completa, aunque todo cruce', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    const r = await cruzar(
      servicio,
      factura({
        impreso: {
          subtotal: 999_999,
          iva: 19_000,
          retencion: 0,
          total: 119_000,
        },
      }),
    );

    expect(r.preguntas).toHaveLength(0);
    expect(r.completa).toBe(false);
    expect(r.lineas).toEqual([]);
  });
});

describe('CruceService — los gastos', () => {
  const arriendo = factura({
    renglones: [
      {
        codigo: null,
        descripcion: 'ARRENDAMIENTO LOCAL COMERCIAL',
        clase: 'GASTO',
        cuentaPuc: null,
        cantidad: 1,
        valorUnitario: 1_500_000,
        ivaTarifa: 0,
        total: 1_500_000,
      },
    ],
    impreso: { subtotal: 1_500_000, iva: 0, retencion: 0, total: 1_500_000 },
  });

  it('sin el código del PUC impreso, se pregunta la cuenta', async () => {
    const { servicio } = armar({ terceros: [tercero()] });

    const r = await cruzar(servicio, arriendo);

    expect(r.completa).toBe(false);
    expect(r.preguntas[0].texto).toContain('¿Cuál uso?');
  });

  it('con el código impreso, cruza y arma la línea de gasto', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      cuentas: {
        '512005': {
          id: 'cta-1',
          codigo: '512005',
          nombre: 'Arrendamientos',
          esAuxiliar: true,
        },
      },
    });

    const conCodigo = {
      ...arriendo,
      renglones: [{ ...arriendo.renglones[0], cuentaPuc: '512005' }],
    };
    const r = await cruzar(servicio, conCodigo);

    expect(r.completa).toBe(true);
    expect(r.lineas[0]).toMatchObject({
      cuentaId: 'cta-1',
      detalle: 'ARRENDAMIENTO LOCAL COMERCIAL',
      ivaTarifa: 0,
    });
  });
});

describe('CruceService — lo que recuerda', () => {
  const arriendoDe = (mes: string) =>
    factura({
      numero: null,
      renglones: [
        {
          codigo: null,
          descripcion: `ARRENDAMIENTO LOCAL COMERCIAL ${mes} 2026`,
          clase: 'GASTO',
          cuentaPuc: null,
          cantidad: 1,
          valorUnitario: 1_500_000,
          ivaTarifa: 0,
          total: 1_500_000,
        },
      ],
      impreso: { subtotal: 1_500_000, iva: 0, retencion: 0, total: 1_500_000 },
    });

  const recordado: Recordado = {
    clase: 'GASTO',
    texto: 'ARRENDAMIENTO LOCAL COMERCIAL',
    productoId: null,
    cuentaId: 'cta-512005',
    numeroFactura: 'CC-0924',
  };

  const arrendamientos = (
    cambios: { activa?: boolean; es_auxiliar?: boolean } = {},
  ) => ({
    'cta-512005': {
      id: 'cta-512005',
      codigo: '512005',
      nombre: 'Arrendamientos',
      activa: true,
      es_auxiliar: true,
      ...cambios,
    },
  });

  // El caso por el que existe: el arriendo de octubre ya no pregunta en
  // noviembre, aunque el texto diga otro mes.
  it('el gasto de otro mes ya no pregunta la cuenta', async () => {
    const { servicio, recordados } = armar({
      terceros: [tercero()],
      recordados: [recordado],
      cuentasPorId: arrendamientos(),
    });

    const r = await cruzar(servicio, arriendoDe('NOVIEMBRE'));

    expect(recordados).toHaveBeenCalledWith(ctx, 'prov-1', [
      { clase: 'GASTO', texto: 'ARRENDAMIENTO LOCAL COMERCIAL' },
    ]);
    expect(r.renglones[0]).toMatchObject({
      resuelto: { clase: 'GASTO', id: 'cta-512005', codigo: '512005' },
      forma: 'APRENDIDO',
    });
    expect(r.renglones[0].motivo).toContain('CC-0924');
    // Solo queda el número, que una cuenta de cobro no trae nunca.
    expect(r.preguntas.map((p) => p.sobre)).toEqual(['numero']);
  });

  it('si la cuenta ya no recibe movimientos, vuelve a preguntar y dice por qué', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      recordados: [recordado],
      cuentasPorId: arrendamientos({ es_auxiliar: false }),
    });

    const r = await cruzar(servicio, arriendoDe('NOVIEMBRE'));

    expect(r.renglones[0].resuelto).toBeNull();
    expect(r.renglones[0].motivo).toMatch(
      /lo había recordado, pero .*no recibe movimientos/i,
    );
    expect(r.renglones[0].motivo).toContain('¿Cuál uso?');
  });

  it('un producto inactivo no se usa aunque se recuerde', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      recordados: [
        {
          clase: 'PRODUCTO',
          texto: 'TECLADO INALAMBRICO',
          productoId: 'prod-viejo',
          cuentaId: null,
          numeroFactura: '215000',
        },
      ],
      productosPorId: {
        'prod-viejo': {
          id: 'prod-viejo',
          codigo: 'P000',
          nombre: 'TECLADO',
          activo: false,
        },
      },
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO INALAMBRICO')] },
    });

    const r = await cruzar(servicio, factura());

    // Cae al catálogo, que lo encuentra por código.
    expect(r.renglones[0].resuelto?.id).toBe('prod-1');
    expect(r.renglones[0].forma).toBe('CODIGO');
  });

  it('sin proveedor por NIT no se consulta la memoria', async () => {
    const { servicio, recordados } = armar({
      terceros: [],
      recordados: [recordado],
    });

    await cruzar(servicio, arriendoDe('NOVIEMBRE'));

    expect(recordados).not.toHaveBeenCalled();
  });
});

describe('CruceService — el mismo producto en dos renglones', () => {
  // La factura de Jaltech lo traía cuatro veces, y la compra no lo acepta.
  it('los junta al costo promedio y lo dice', async () => {
    const { servicio } = armar({
      terceros: [tercero()],
      productos: { P001: [producto('prod-1', 'P001', 'TECLADO')] },
    });

    const dos = factura({
      renglones: [
        {
          codigo: 'P001',
          descripcion: 'TECLADO',
          clase: 'PRODUCTO',
          cuentaPuc: null,
          cantidad: 2,
          valorUnitario: 10_000,
          ivaTarifa: 19,
          total: 20_000,
        },
        {
          codigo: 'P001',
          descripcion: 'TECLADO',
          clase: 'PRODUCTO',
          cuentaPuc: null,
          cantidad: 3,
          valorUnitario: 15_000,
          ivaTarifa: 19,
          total: 45_000,
        },
      ],
      impreso: { subtotal: 65_000, iva: 12_350, retencion: 0, total: 77_350 },
    });

    const r = await cruzar(servicio, dos);

    expect(r.completa).toBe(true);
    expect(r.juntadas).toBe(1);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0].cantidad).toBe(5);
    expect(r.lineas[0].costoUnitario).toBe(13_000);
    // Los dos renglones siguen visibles: la pantalla muestra lo que dice el
    // papel, no lo que el sistema hizo con él.
    expect(r.renglones).toHaveLength(2);
  });
});

describe('CruceService — el pedido de un cliente', () => {
  const cliente = (esCliente = true) => ({
    ...tercero(),
    esCliente,
    esProveedor: false,
  });

  const armarPedido = (
    precios: Record<string, number | null>,
    esCliente = true,
  ) => {
    const nucleo = {
      terceroPorDocumento: jest.fn().mockResolvedValue([cliente(esCliente)]),
    } as unknown as NucleoApi;
    const inventario = {
      buscarProductos: jest.fn().mockImplementation((_c: unknown, q: string) =>
        Promise.resolve(
          {
            P001: [producto('prod-1', 'P001', 'TECLADO')],
            P002: [producto('prod-2', 'P002', 'MOUSE')],
          }[q] ?? [],
        ),
      ),
      precioVigente: jest
        .fn()
        .mockImplementation((_c: unknown, id: string) =>
          Promise.resolve(precios[id] ?? null),
        ),
    } as unknown as InventarioApi;
    const memoria = { recordados: jest.fn() } as unknown as MemoriaService;
    return new CruceService(nucleo, inventario, memoria);
  };

  const pedido = (
    renglones: Array<[string, number, number | null]>,
  ): PedidoLeido => ({
    cliente: { nombre: 'JALTECH', nit: '900378652' },
    numero: 'OC-1',
    fecha: null,
    renglones: renglones.map(([codigo, cantidad, valorUnitario]) => ({
      codigo,
      descripcion: codigo,
      cantidad,
      valorUnitario,
    })),
    subtotalImpreso: 0,
  });

  it('resuelve cliente y productos, con el precio de la lista', async () => {
    const servicio = armarPedido({ 'prod-1': 50_000, 'prod-2': 20_000 });
    const r = await servicio.cruzarPedido(
      ctx,
      pedido([
        ['P001', 2, 50_000],
        ['P002', 1, null],
      ]),
      [],
    );

    expect(r.cliente).toEqual({
      id: 'prov-1',
      nombre: 'JALTECH SOLUCIONES S.A.S.',
    });
    expect(r.lineas).toEqual([
      { productoId: 'prod-1', cantidad: 2 },
      { productoId: 'prod-2', cantidad: 1 },
    ]);
    expect(r.renglones[0]).toMatchObject({
      precioLista: 50_000,
      avisoPrecio: null,
    });
    expect(r.completa).toBe(true);
  });

  it('si el pedido dice otro precio, avisa y deja el de la lista', async () => {
    const servicio = armarPedido({ 'prod-1': 50_000 });
    const r = await servicio.cruzarPedido(
      ctx,
      pedido([['P001', 2, 45_000]]),
      [],
    );

    expect(r.renglones[0].avisoPrecio).toContain('Se factura a $ 50.000');
    // Es un aviso, no una pregunta: se puede facturar igual.
    expect(r.completa).toBe(true);
  });

  it('el mismo producto en dos renglones se junta, sumando cantidades', async () => {
    const servicio = armarPedido({ 'prod-1': 50_000 });
    const r = await servicio.cruzarPedido(
      ctx,
      pedido([
        ['P001', 2, null],
        ['P001', 3, null],
      ]),
      [],
    );

    expect(r.lineas).toEqual([{ productoId: 'prod-1', cantidad: 5 }]);
    expect(r.juntadas).toBe(1);
  });

  // La venta lo rechazaría con un 400: se dice antes de abrir el formulario.
  it('un producto sin precio de lista es una pregunta', async () => {
    const servicio = armarPedido({ 'prod-1': null });
    const r = await servicio.cruzarPedido(ctx, pedido([['P001', 2, null]]), []);

    expect(r.preguntas[0].texto).toContain('no tiene precio de venta');
    expect(r.lineas).toEqual([]);
    expect(r.completa).toBe(false);
  });

  it('un tercero que no es cliente es una pregunta', async () => {
    const servicio = armarPedido({ 'prod-1': 1 }, false);
    const r = await servicio.cruzarPedido(ctx, pedido([['P001', 1, null]]), []);

    expect(r.cliente).toBeNull();
    expect(r.preguntas[0].sobre).toBe('cliente');
  });
});
