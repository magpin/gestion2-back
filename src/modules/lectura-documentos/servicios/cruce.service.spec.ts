import type { CtxEmpresa } from '../../../common/ctx';
import type { InventarioApi } from '../../inventario/inventario.api';
import type { NucleoApi } from '../../nucleo/nucleo.api';
import { comprobar, type FacturaCompraLeida } from '../reglas/factura-compra.reglas';
import { CruceService } from './cruce.service';

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

/** Las dos APIs de las que depende el cruce, de mentira. */
const armar = (opciones: {
  terceros?: ReturnType<typeof tercero>[];
  productos?: Record<string, ReturnType<typeof producto>[]>;
  cuentas?: Record<string, { id: string; codigo: string; nombre: string; esAuxiliar: boolean }>;
}) => {
  const productos = opciones.productos ?? {};
  const nucleo = {
    terceroPorDocumento: jest.fn().mockResolvedValue(opciones.terceros ?? []),
    cuenta: jest
      .fn()
      .mockImplementation((_c: unknown, codigo: string) =>
        Promise.resolve(opciones.cuentas?.[codigo] ?? null),
      ),
  } as unknown as NucleoApi;
  const inventario = {
    buscarProductos: jest
      .fn()
      .mockImplementation((_c: unknown, q: string) =>
        Promise.resolve(productos[q] ?? []),
      ),
  } as unknown as InventarioApi;
  return { servicio: new CruceService(nucleo, inventario), nucleo, inventario };
};

const factura = (cambios: Partial<FacturaCompraLeida> = {}): FacturaCompraLeida => ({
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
      { productoId: 'prod-1', cantidad: 2, costoUnitario: 50_000, valor: 100_000 },
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
        impreso: { subtotal: 999_999, iva: 19_000, retencion: 0, total: 119_000 },
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
