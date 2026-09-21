import {
  aprovechamientoCache,
  armarTablero,
  diasEntre,
  percentil,
  type FilaLectura,
  type FilaRespuesta,
} from './consumo';

const respuesta = (e: Partial<FilaRespuesta> = {}): FilaRespuesta => ({
  id: 't-1',
  empresaId: 'e-1',
  empresa: 'Empresa Demo',
  dia: '2026-09-21',
  fecha: '2026-09-21T15:00:00Z',
  estado: 'COMPLETO',
  modelo: 'claude-opus-5',
  uso: { entrada: 100, salida: 200, cacheLeido: 9_000, cacheEscrito: 1_000 },
  duracionMs: 4_000,
  vueltas: 2,
  consultas: 1,
  ...e,
});

const lectura = (e: Partial<FilaLectura> = {}): FilaLectura => ({
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

// 100×5 + 200×25 + 9.000×0,5 + 1.000×6,25 = 16.250 por millón.
const COSTO_RESPUESTA = 0.01625;
// 2.000×5 + 500×25 = 22.500 por millón.
const COSTO_LECTURA = 0.0225;

describe('armarTablero', () => {
  const tablero = armarTablero(
    [
      respuesta(),
      respuesta({
        id: 't-2',
        empresaId: 'e-2',
        empresa: 'Otra',
        dia: '2026-09-20',
        duracionMs: 10_000,
        consultas: 3,
      }),
    ],
    [
      lectura(),
      lectura({
        tipo: 'CAMARA_COMERCIO',
        estado: 'FALLO',
        uso: null,
        duracionMs: null,
      }),
    ],
    '2026-09-19',
    '2026-09-21',
  );

  it('los totales suman chat y lectura, con la tarifa de cada modelo', () => {
    expect(tablero.totales.costoUsd).toBeCloseTo(
      2 * COSTO_RESPUESTA + COSTO_LECTURA,
      8,
    );
    expect(tablero.totales).toMatchObject({
      respuestas: 2,
      documentos: 2,
      empresas: 2,
    });
    expect(tablero.totales.costoPorRespuesta).toBeCloseTo(COSTO_RESPUESTA, 8);
  });

  it('por día, todos los días del rango, también los que no tuvieron nada', () => {
    expect(tablero.porDia.map((d) => [d.dia, d.respuestas])).toEqual([
      ['2026-09-19', 0],
      ['2026-09-20', 1],
      ['2026-09-21', 1],
    ]);
    expect(tablero.porDia[2].lecturaUsd).toBeCloseTo(COSTO_LECTURA, 8);
  });

  it('por empresa, la más cara primero', () => {
    expect(tablero.porEmpresa.map((e) => e.empresa)).toEqual([
      'Empresa Demo',
      'Otra',
    ]);
    expect(tablero.porEmpresa[0]).toMatchObject({
      respuestas: 1,
      documentos: 2,
    });
  });

  it('la eficiencia: caché, consultas, vueltas y tiempos', () => {
    expect(tablero.eficiencia.aprovechamientoCache).toBeCloseTo(
      9_000 / 10_100,
      6,
    );
    expect(tablero.eficiencia.consultasPorRespuesta).toBe(2);
    expect(tablero.eficiencia.vueltasPorRespuesta).toBe(2);
    expect(tablero.eficiencia.duracionMediana).toBe(4_000);
    expect(tablero.eficiencia.duracionP95).toBe(10_000);
  });

  it('la simulación: Sonnet cuesta el 40 % de Opus con los mismos tokens', () => {
    expect(tablero.simulacion.opus).toBeCloseTo(tablero.totales.costoUsd, 8);
    expect(tablero.simulacion.sonnet).toBeCloseTo(
      tablero.totales.costoUsd * 0.4,
      8,
    );
    expect(tablero.simulacion.haiku).toBeLessThan(tablero.simulacion.sonnet);
  });

  it('la lectura por tipo: las fallidas y las que no tienen medición se cuentan aparte', () => {
    const camara = tablero.lectura.find((l) => l.tipo === 'CAMARA_COMERCIO')!;
    expect(camara).toMatchObject({
      cantidad: 1,
      fallidas: 1,
      medidas: 0,
      costoPromedio: null,
    });
  });

  it('las más caras no traen texto: solo cifras y de quién', () => {
    expect(Object.keys(tablero.masCaras[0]).sort()).toEqual(
      [
        'consultas',
        'costoUsd',
        'duracionMs',
        'empresa',
        'estado',
        'fecha',
        'modelo',
        'tokens',
        'vueltas',
      ].sort(),
    );
  });

  it('un período vacío no rompe: ceros y nulos, no NaN', () => {
    const vacio = armarTablero([], [], '2026-09-21', '2026-09-21');
    expect(vacio.totales.costoPorRespuesta).toBeNull();
    expect(vacio.eficiencia.duracionMediana).toBeNull();
    expect(vacio.porDia).toHaveLength(1);
  });
});

describe('ayudantes', () => {
  it('percentil', () => {
    expect(percentil([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentil([], 0.5)).toBeNull();
  });

  it('diasEntre incluye los dos bordes', () => {
    expect(diasEntre('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('aprovechamiento del caché', () => {
    expect(
      aprovechamientoCache({
        entrada: 0,
        salida: 0,
        cacheLeido: 0,
        cacheEscrito: 0,
      }),
    ).toBe(0);
    expect(
      aprovechamientoCache({
        entrada: 10,
        salida: 5,
        cacheLeido: 90,
        cacheEscrito: 0,
      }),
    ).toBe(0.9);
  });
});
