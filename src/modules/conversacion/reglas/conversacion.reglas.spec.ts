import {
  costoUsd,
  entradaTotal,
  hiloParaModelo,
  superaTope,
  type TurnoGuardado,
} from './conversacion.reglas';

const persona = (texto: string): TurnoGuardado => ({
  autor: 'PERSONA',
  texto,
  estado: 'COMPLETO',
});
const asistente = (
  texto: string,
  estado: TurnoGuardado['estado'] = 'COMPLETO',
): TurnoGuardado => ({
  autor: 'ASISTENTE',
  texto,
  estado,
});

describe('hiloParaModelo', () => {
  it('viaja el hilo en orden, sin el estado', () => {
    expect(
      hiloParaModelo([
        persona('¿Cómo cobro?'),
        asistente('Con «Cobrar».'),
        persona('¿Y en banco?'),
      ]),
    ).toEqual([
      { autor: 'PERSONA', texto: '¿Cómo cobro?' },
      { autor: 'ASISTENTE', texto: 'Con «Cobrar».' },
      { autor: 'PERSONA', texto: '¿Y en banco?' },
    ]);
  });

  it('un rechazo o una falla del asistente no viaja: no dijo nada', () => {
    const hilo = hiloParaModelo([
      persona('a'),
      asistente('', 'RECHAZADO'),
      persona('b'),
      asistente('', 'FALLO'),
      persona('c'),
    ]);
    expect(hilo.map((t) => t.autor)).toEqual(['PERSONA', 'PERSONA', 'PERSONA']);
  });

  it('un corte viaja con lo que alcanzó: es lo que la persona leyó', () => {
    const hilo = hiloParaModelo([
      persona('a'),
      asistente('Lo que alcan', 'CORTADO'),
      persona('b'),
    ]);
    expect(hilo[1]).toEqual({ autor: 'ASISTENTE', texto: 'Lo que alcan' });
  });

  it('un corte vacío no viaja', () => {
    expect(
      hiloParaModelo([persona('a'), asistente('  ', 'CORTADO')]),
    ).toHaveLength(1);
  });

  it('empieza siempre por la persona', () => {
    expect(hiloParaModelo([asistente('suelto'), persona('hola')])).toEqual([
      { autor: 'PERSONA', texto: 'hola' },
    ]);
    expect(hiloParaModelo([asistente('solo')])).toEqual([]);
  });
});

describe('el tope y el costo', () => {
  const uso = {
    entrada: 1_000,
    salida: 500,
    cacheEscrito: 2_000,
    cacheLeido: 57_000,
  };

  it('la entrada total suma lo nuevo y los dos lados del caché', () => {
    expect(entradaTotal(uso)).toBe(60_000);
  });

  it('se supera el tope con el uso real de la última respuesta', () => {
    expect(superaTope(uso)).toBe(true);
    expect(superaTope({ ...uso, cacheLeido: 56_999 })).toBe(false);
    expect(superaTope(null)).toBe(false);
  });

  it('el costo cobra el caché leído a una décima y el escrito a 1,25', () => {
    // 1.000×5 + 500×25 + 57.000×0,5 + 2.000×6,25 = 58.500 millonésimas
    expect(costoUsd(uso)).toBeCloseTo(0.0585, 6);
  });
});
