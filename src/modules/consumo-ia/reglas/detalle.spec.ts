import {
  armarDetalle,
  categoriaDe,
  desglosar,
  etiquetaHerramienta,
  type FilaLecturaDetalle,
  type FilaRespuestaDetalle,
  type FiltroDetalle,
} from './detalle';

const respuesta = (
  e: Partial<FilaRespuestaDetalle> = {},
): FilaRespuestaDetalle => ({
  id: 't-1',
  empresaId: 'e-1',
  empresa: 'Empresa Demo',
  dia: '2026-09-21',
  fecha: '2026-09-21T15:00:00.000Z',
  estado: 'COMPLETO',
  modelo: 'claude-opus-5',
  uso: { entrada: 100, salida: 200, cacheLeido: 9_000, cacheEscrito: 1_000 },
  duracionMs: 4_000,
  vueltas: 2,
  consultas: 0,
  herramientas: [],
  propuestas: 0,
  ...e,
});

const lectura = (e: Partial<FilaLecturaDetalle> = {}): FilaLecturaDetalle => ({
  id: 'd-1',
  fecha: '2026-09-21T10:00:00.000Z',
  empresaId: 'e-1',
  empresa: 'Empresa Demo',
  dia: '2026-09-21',
  tipo: 'RUT',
  estado: 'LEIDO',
  modelo: 'claude-opus-5',
  uso: { entrada: 2_000, salida: 500, cacheLeido: 0, cacheEscrito: 0 },
  duracionMs: 7_000,
  ...e,
});

const FILTRO: FiltroDetalle = {
  categoria: null,
  orden: 'FECHA',
  pagina: 1,
  porPagina: 50,
};

// 100×5 + 200×25 + 9.000×0,5 + 1.000×6,25 = 16.250 por millón.
const COSTO_RESPUESTA = 0.01625;
// 2.000×5 + 500×25 = 22.500 por millón.
const COSTO_LECTURA = 0.0225;

describe('categoriaDe', () => {
  it('sin herramientas es ayuda; con consultas, consulta; si propuso, propuesta', () => {
    expect(categoriaDe(respuesta())).toBe('AYUDA');
    expect(
      categoriaDe(
        respuesta({ herramientas: ['buscar_valores', 'consultar_cartera'] }),
      ),
    ).toBe('CONSULTA');
    expect(
      categoriaDe(
        respuesta({ herramientas: ['consultar_saldos', 'proponer_cobro'] }),
      ),
    ).toBe('PROPUESTA');
    // Una propuesta guardada cuenta aunque la herramienta no quedara anotada.
    expect(categoriaDe(respuesta({ propuestas: 1 }))).toBe('PROPUESTA');
  });
});

describe('desglosar', () => {
  it('parte el costo por clase de token y las partes suman el total', () => {
    const d = desglosar(respuesta().uso, 'claude-opus-5');
    expect(d.entrada).toBeCloseTo(0.0005, 10);
    expect(d.salida).toBeCloseTo(0.005, 10);
    expect(d.cacheLeido).toBeCloseTo(0.0045, 10);
    expect(d.cacheEscrito).toBeCloseTo(0.00625, 10);
    expect(d.entrada + d.salida + d.cacheLeido + d.cacheEscrito).toBeCloseTo(
      d.total,
      10,
    );
    expect(d.total).toBeCloseTo(COSTO_RESPUESTA, 10);
  });

  it('con la tarifa del modelo que respondió', () => {
    expect(desglosar(respuesta().uso, 'claude-sonnet-5').total).toBeCloseTo(
      COSTO_RESPUESTA * 0.4,
      10,
    );
  });
});

describe('armarDetalle', () => {
  it('cada llamada es una fila, con en qué se gastó', () => {
    const d = armarDetalle(
      [
        respuesta({
          id: 't-1',
          herramientas: [
            'buscar_valores',
            'consultar_cartera',
            'consultar_cartera',
          ],
        }),
      ],
      [lectura({ tipo: 'CAMARA_COMERCIO' })],
      '2026-09-21',
      '2026-09-21',
      FILTRO,
    );
    expect(d.total).toBe(2);
    const chat = d.filas.find((f) => f.id === 't-1');
    expect(chat?.categoria).toBe('CONSULTA');
    expect(chat?.enQue).toBe('Búsqueda de nombres, Cartera');
    expect(chat?.herramientas).toEqual([
      { nombre: 'buscar_valores', etiqueta: 'Búsqueda de nombres', veces: 1 },
      { nombre: 'consultar_cartera', etiqueta: 'Cartera', veces: 2 },
    ]);
    const doc = d.filas.find((f) => f.id === 'd-1');
    expect(doc?.categoria).toBe('LECTURA');
    expect(doc?.enQue).toBe('Cámara de Comercio');
  });

  it('el resumen por categoría tiene las cuatro, con su parte del costo', () => {
    const d = armarDetalle(
      [
        respuesta({ id: 'a' }),
        respuesta({ id: 'b', herramientas: ['consultar_ventas'] }),
      ],
      [lectura()],
      '2026-09-21',
      '2026-09-21',
      FILTRO,
    );
    const total = COSTO_RESPUESTA * 2 + COSTO_LECTURA;
    const por = Object.fromEntries(d.porCategoria.map((c) => [c.categoria, c]));
    expect(Object.keys(por)).toEqual([
      'AYUDA',
      'CONSULTA',
      'PROPUESTA',
      'LECTURA',
    ]);
    expect(por.AYUDA.llamadas).toBe(1);
    expect(por.PROPUESTA.llamadas).toBe(0);
    expect(por.LECTURA.costoUsd).toBeCloseTo(COSTO_LECTURA, 10);
    expect(por.CONSULTA.participacion).toBeCloseTo(COSTO_RESPUESTA / total, 10);
    expect(d.porCategoria.reduce((s, c) => s + c.participacion, 0)).toBeCloseTo(
      1,
      10,
    );
  });

  it('por herramienta: una respuesta con dos herramientas cuenta en las dos', () => {
    const d = armarDetalle(
      [
        respuesta({
          id: 'a',
          herramientas: ['consultar_cartera', 'consultar_saldos'],
        }),
        respuesta({ id: 'b', herramientas: ['consultar_cartera'] }),
      ],
      [],
      '2026-09-21',
      '2026-09-21',
      FILTRO,
    );
    const cartera = d.porHerramienta.find(
      (h) => h.herramienta === 'consultar_cartera',
    );
    expect(cartera).toMatchObject({
      respuestas: 2,
      veces: 2,
      etiqueta: 'Cartera',
    });
    expect(cartera?.costoUsd).toBeCloseTo(COSTO_RESPUESTA * 2, 10);
    expect(d.porHerramienta[0].herramienta).toBe('consultar_cartera');
  });

  it('el filtro de categoría acota la lista, pero no el resumen', () => {
    const d = armarDetalle(
      [
        respuesta({ id: 'a' }),
        respuesta({ id: 'b', herramientas: ['consultar_ventas'] }),
      ],
      [lectura()],
      '2026-09-21',
      '2026-09-21',
      { ...FILTRO, categoria: 'CONSULTA' },
    );
    expect(d.filas.map((f) => f.id)).toEqual(['b']);
    expect(d.total).toBe(1);
    expect(d.totalUsd).toBeCloseTo(COSTO_RESPUESTA, 10);
    expect(d.porCategoria.reduce((s, c) => s + c.llamadas, 0)).toBe(3);
  });

  it('ordena por fecha, lo último primero, o por costo', () => {
    const filas = [
      respuesta({ id: 'vieja', fecha: '2026-09-20T10:00:00.000Z' }),
      respuesta({
        id: 'cara',
        fecha: '2026-09-19T10:00:00.000Z',
        uso: { entrada: 50_000, salida: 2_000, cacheLeido: 0, cacheEscrito: 0 },
      }),
      respuesta({ id: 'nueva', fecha: '2026-09-21T10:00:00.000Z' }),
    ];
    const porFecha = armarDetalle(
      filas,
      [],
      '2026-09-19',
      '2026-09-21',
      FILTRO,
    );
    expect(porFecha.filas.map((f) => f.id)).toEqual(['nueva', 'vieja', 'cara']);
    const porCosto = armarDetalle(filas, [], '2026-09-19', '2026-09-21', {
      ...FILTRO,
      orden: 'COSTO',
    });
    expect(porCosto.filas[0].id).toBe('cara');
  });

  it('pagina, y una página de más se queda en la última', () => {
    const filas = Array.from({ length: 5 }, (_, i) =>
      respuesta({ id: `t-${i}`, fecha: `2026-09-21T1${i}:00:00.000Z` }),
    );
    const d = armarDetalle(filas, [], '2026-09-21', '2026-09-21', {
      ...FILTRO,
      porPagina: 2,
      pagina: 9,
    });
    expect(d.paginas).toBe(3);
    expect(d.pagina).toBe(3);
    expect(d.filas.map((f) => f.id)).toEqual(['t-0']);
  });

  it('una lectura sin medir aparece, sin costo, y no suma', () => {
    const d = armarDetalle(
      [],
      [lectura({ uso: null })],
      '2026-09-21',
      '2026-09-21',
      FILTRO,
    );
    expect(d.filas[0].costo).toBeNull();
    expect(d.filas[0].tokens).toBeNull();
    expect(d.totalUsd).toBe(0);
    expect(
      d.porCategoria.find((c) => c.categoria === 'LECTURA')?.llamadas,
    ).toBe(1);
  });

  it('una herramienta nueva sale con su nombre', () => {
    expect(etiquetaHerramienta('consultar_nomina')).toBe('consultar_nomina');
  });
});
