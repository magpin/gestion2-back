import {
  motivoNoSeLee,
  numeroComparable,
  resumenDelLote,
  situacionDelLote,
  type FilaArchivo,
} from './lote.reglas';

const factura = (
  numero: string,
  extra: Partial<{
    proveedor: unknown;
    preguntas: unknown[];
    cuadra: boolean;
  }> = {},
) => ({
  factura: {
    proveedor: { nombre: 'Papelería Central', nit: '900111' },
    numero,
    prefijo: 'FC',
    impreso: { total: 2_380_000 },
  },
  proveedor:
    'proveedor' in extra
      ? extra.proveedor
      : { id: 'p1', nombre: 'Papelería Central S.A.S.' },
  comprobaciones: [{ que: 'El total da', cuadra: extra.cuadra ?? true }],
  preguntas: extra.preguntas ?? [],
});

let orden = 0;
const derivado = (
  extraido: unknown,
  cambios: Partial<FilaArchivo> = {},
  estado: NonNullable<FilaArchivo['documento']>['estado'] = 'LEIDO',
): FilaArchivo => ({
  id: `a${orden}`,
  orden: orden++,
  nombre: `archivo-${orden}.pdf`,
  estado: 'DERIVADO',
  clase: 'Factura de compra',
  motivo: null,
  documento: {
    id: `d${orden}`,
    tipo: 'FACTURA_COMPRA',
    estado,
    extraido,
    error: null,
    motivoDescarte: null,
  },
  registrado: null,
  duplicadoDe: null,
  ...cambios,
});

beforeEach(() => {
  orden = 0;
});

describe('numeroComparable', () => {
  it('ignora guiones, espacios, mayúsculas y ceros a la izquierda', () => {
    expect(numeroComparable('FC-0231')).toBe(numeroComparable('fc 231'));
    expect(numeroComparable('000456')).toBe('456');
  });
});

describe('situacionDelLote', () => {
  it('una factura que pasa todo queda lista para aprobar, con su título y valor', () => {
    const [a] = situacionDelLote([derivado(factura('0231'))]);
    expect(a).toMatchObject({
      situacion: 'LISTA',
      titulo: 'Papelería Central S.A.S. · FC-0231',
      descripcion: 'Factura de compra',
      valor: 2_380_000,
      motivos: [],
    });
  });

  it('se aparta con cada motivo que tenga, del más serio al más leve', () => {
    const [a] = situacionDelLote([
      derivado(
        factura('9', { proveedor: null, cuadra: false, preguntas: [{}, {}] }),
        {
          duplicadoDe: {
            id: 'c',
            numero: 'FC-9',
            fecha: '2026-09-02',
            total: 1,
          },
        },
      ),
    ]);
    expect(a.situacion).toBe('APARTADA');
    expect(a.motivos.map((m) => m.clave)).toEqual([
      'DUPLICADO',
      'SIN_TERCERO',
      'NO_CUADRA',
      'PREGUNTAS',
    ]);
    expect(a.motivos[0].texto).toBe(
      'Posible duplicado: ya está registrada como FC-9',
    );
    expect(a.motivos[3].texto).toBe('Me faltan 2 datos');
  });

  it('la segunda copia del mismo documento en el lote se aparta como repetida', () => {
    const [a, b] = situacionDelLote([
      derivado(factura('0231')),
      derivado(factura('231')),
    ]);
    expect(a.situacion).toBe('LISTA');
    expect(b.situacion).toBe('APARTADA');
    expect(b.motivos[0]).toEqual({
      clave: 'REPETIDO_EN_LOTE',
      texto: 'Es la misma que archivo-1.pdf, en este mismo lote',
    });
  });

  it('registrada y descartada no se vuelven a ofrecer', () => {
    const [a, b] = situacionDelLote([
      derivado(factura('1'), { registrado: { id: 'c', numero: 'FC-1' } }),
      derivado(factura('2'), {}, 'DESCARTADO'),
    ]);
    expect(a.situacion).toBe('REGISTRADA');
    expect(b.situacion).toBe('DESCARTADA');
  });

  it('lo que no se lee, lo que falló y lo detenido dicen por qué', () => {
    const lote = situacionDelLote([
      {
        ...derivado(null),
        estado: 'NO_SE_LEE',
        documento: null,
        clase: 'Extracto bancario',
        motivo: 'Extracto bancario: no es algo que yo lea.',
      },
      { ...derivado(null), estado: 'DETENIDO', documento: null },
      derivado(null, {}, 'LEYENDO'),
    ]);
    expect(lote.map((a) => a.situacion)).toEqual([
      'NO_SE_LEE',
      'DETENIDO',
      'LEYENDO',
    ]);
    expect(lote[0].descripcion).toBe('Extracto bancario');
    expect(lote[0].nota).toContain('no es algo');
    expect(lote[1].nota).toContain('se detuvo');
  });

  it('un RUT del lote se confirma en su tarjeta de siempre', () => {
    const f = derivado([]);
    f.documento!.tipo = 'RUT';
    expect(situacionDelLote([f])[0]).toMatchObject({
      situacion: 'CONFIGURACION',
      descripcion: 'RUT',
    });
  });
});

describe('resumenDelLote', () => {
  it('cuenta hechos, listas y apartadas, y dice cuál se lee ahora', () => {
    const archivos = situacionDelLote([
      derivado(factura('1')),
      derivado(factura('2', { proveedor: null })),
      derivado(null, {}, 'LEYENDO'),
      { ...derivado(null), estado: 'EN_COLA', documento: null },
    ]);
    expect(resumenDelLote(archivos)).toEqual({
      total: 4,
      hechos: 2,
      listas: 1,
      apartadas: 1,
      actual: 'archivo-3.pdf',
    });
  });
});

describe('motivoNoSeLee', () => {
  it('dice qué es y qué sí lee', () => {
    expect(
      motivoNoSeLee({ tipo: null, clase: 'Extracto bancario' }, false),
    ).toMatch(/^Extracto bancario: no es algo que yo lea/);
  });
  it('dice cuándo es algo que lee pero no le toca a quien lo subió', () => {
    expect(
      motivoNoSeLee({ tipo: 'PEDIDO_VENTA', clase: 'Pedido' }, false),
    ).toContain('facturar no le corresponde');
    expect(
      motivoNoSeLee({ tipo: 'FACTURA_COMPRA', clase: 'Factura' }, true),
    ).toBeNull();
  });
});
