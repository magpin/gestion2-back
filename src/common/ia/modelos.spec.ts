import {
  costoSimulado,
  costoUsd,
  modeloPara,
  TARIFAS,
  tarifaDe,
} from './modelos';

describe('tarifaDe — por la familia del modelo que contestó', () => {
  it('reconoce Opus, Sonnet y Haiku, y lo desconocido se cobra como Opus', () => {
    expect(tarifaDe('claude-opus-5')).toBe(TARIFAS.OPUS);
    expect(tarifaDe('claude-sonnet-5')).toBe(TARIFAS.SONNET);
    expect(tarifaDe('claude-haiku-4-5-20251001')).toBe(TARIFAS.HAIKU);
    expect(tarifaDe('otro')).toBe(TARIFAS.OPUS);
    expect(tarifaDe(null)).toBe(TARIFAS.OPUS);
  });
});

describe('costoUsd', () => {
  // Turno 2 de la 4b, medido en Opus: US$ 0,0079.
  const turno2 = {
    entrada: 188,
    salida: 218,
    cacheLeido: 2571,
    cacheEscrito: 0,
  };

  it('con la tarifa del modelo de la fila', () => {
    // 188 × 5 + 218 × 25 + 2.571 × 0,5 = 7.675,5 por millón.
    expect(costoUsd(turno2, 'claude-opus-5')).toBeCloseTo(0.0076755, 7);
    expect(costoUsd(turno2, 'claude-sonnet-5')).toBeCloseTo(0.0076755 * 0.4, 7);
  });
});

describe('costoSimulado — lo mismo con otra tarifa', () => {
  it('con un prefijo menor que su mínimo de caché, Haiku paga todo como entrada', () => {
    const chico = {
      entrada: 188,
      salida: 218,
      cacheLeido: 2571,
      cacheEscrito: 0,
    };
    // 2.759 tokens de entrada a US$ 1 y 218 de salida a US$ 5.
    expect(costoSimulado(chico, TARIFAS.HAIKU)).toBeCloseTo(0.00385, 5);
  });

  it('con un prefijo mayor, el caché de Haiku sí rinde', () => {
    const grande = {
      entrada: 100,
      salida: 200,
      cacheLeido: 20_000,
      cacheEscrito: 0,
    };
    expect(costoSimulado(grande, TARIFAS.HAIKU)).toBeCloseTo(
      (100 * 1 + 200 * 5 + 20_000 * 0.1) / 1e6,
      8,
    );
  });
});

describe('modeloPara — el modelo de cada uso, del entorno', () => {
  const antes = { ...process.env };
  afterEach(() => {
    process.env = { ...antes };
  });

  it('sin variable, Opus', () => {
    delete process.env.MODELO_CONVERSACION;
    expect(modeloPara('CONVERSACION')).toBe('claude-opus-5');
  });

  it('con Sonnet, Sonnet', () => {
    process.env.MODELO_CONVERSACION = 'claude-sonnet-5';
    expect(modeloPara('CONVERSACION')).toBe('claude-sonnet-5');
  });

  it('un modelo fuera de la lista no arranca, y dice cuáles se pueden', () => {
    process.env.MODELO_LECTURA = 'claude-haiku-4-5';
    expect(() => modeloPara('LECTURA')).toThrow(
      /claude-opus-5, claude-sonnet-5/,
    );
  });
});
