import { fila, filas } from './filas';

/**
 * Estas pruebas existen por un bug real: `tomarConsecutivo` leía el resultado de
 * un `UPDATE ... RETURNING` como si fuera el de un `SELECT`, y habría numerado
 * facturas con `NaN`. Las comprobaciones de "no encontrado" tampoco se
 * disparaban, porque un arreglo vacío no es `undefined`.
 */
describe('filas', () => {
  it('devuelve las filas de un SELECT tal cual', () => {
    expect(filas([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('desenvuelve el [filas, cantidad] de un UPDATE ... RETURNING', () => {
    expect(filas([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
  });

  it('un UPDATE que no toco nada devuelve lista vacia', () => {
    expect(filas([[], 0])).toEqual([]);
  });

  it('un SELECT sin resultados devuelve lista vacia', () => {
    expect(filas([])).toEqual([]);
  });

  it('tolera null y undefined', () => {
    expect(filas(null)).toEqual([]);
    expect(filas(undefined)).toEqual([]);
  });

  it('no confunde un SELECT de dos filas con la forma de un UPDATE', () => {
    // La forma [filas, cantidad] tiene un arreglo y un numero. Dos filas de un
    // SELECT son dos objetos, y por eso se distinguen sin ambiguedad.
    expect(filas([{ id: 1 }, { id: 2 }])).toHaveLength(2);
  });
});

describe('fila', () => {
  it('devuelve la primera fila de un SELECT', () => {
    expect(fila([{ id: 1 }, { id: 2 }])).toEqual({ id: 1 });
  });

  it('devuelve la primera fila de un UPDATE ... RETURNING', () => {
    expect(fila([[{ consecutivo_actual: '4313' }], 1])).toEqual({
      consecutivo_actual: '4313',
    });
  });

  it('devuelve undefined cuando el UPDATE no toco ninguna fila', () => {
    // Es lo que hace que un `if (x === undefined) throw NotFound` funcione.
    expect(fila([[], 0])).toBeUndefined();
  });

  it('devuelve undefined con un SELECT vacio', () => {
    expect(fila([])).toBeUndefined();
  });
});
