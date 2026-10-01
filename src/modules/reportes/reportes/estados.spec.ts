import {
  balanceGeneral,
  estadoDeResultados,
  flujoDirecto,
} from '../../estados-financieros/estados.reglas';
import {
  filasBalance,
  filasFlujo,
  filasResultados,
  hojaEstado,
  libroEstado,
  variacionDe,
} from './estados';

const mov = (codigo: string, debito: number, credito: number) => ({
  codigo,
  nombre: `Cuenta ${codigo}`,
  debito,
  credito,
});

describe('estados en filas', () => {
  it('resultados: grupos, sus cuentas de los dos períodos y la variación', () => {
    const sep = estadoDeResultados([
      mov('413595', 0, 1_200),
      mov('510506', 300, 0),
    ]);
    const ago = estadoDeResultados([
      mov('413595', 0, 1_000),
      mov('511595', 100, 0),
    ]);
    const filas = filasResultados(sep, ago);
    const admin = filas.findIndex(
      (f) => f.etiqueta === 'Gastos de administración',
    );
    // La cuenta que solo se movió en agosto también va, en cero este mes.
    expect(
      filas
        .slice(admin + 1, admin + 3)
        .map((f) => [f.codigo, f.actual, f.comparado]),
    ).toEqual([
      ['510506', 300, 0],
      ['511595', 0, 100],
    ]);
    const hoja = hojaEstado(filas, {
      actual: 'sep 2026',
      comparado: 'ago 2026',
    });
    expect(hoja.filas[0]).toMatchObject({
      actual: '$ 1.200',
      comparado: '$ 1.000',
      variacion: '+20 %',
    });
  });

  it('balance: secciones, totales y pasivo más patrimonio', () => {
    const b = balanceGeneral(
      [
        { codigo: '110505', nombre: 'Caja', saldo: 1_000 },
        { codigo: '220505', nombre: 'Proveedores', saldo: -400 },
        { codigo: '311505', nombre: 'Capital', saldo: -600 },
      ],
      { ejercicio: 0, anteriores: 0 },
    );
    const filas = filasBalance(b);
    expect(
      filas
        .filter((f) => f.nivel === 'total')
        .map((f) => [f.etiqueta, f.actual]),
    ).toEqual([
      ['Total activo', 1_000],
      ['Total pasivo', 400],
      ['Total patrimonio', 600],
      ['Total pasivo y patrimonio', 1_000],
    ]);
    expect(filas.some((f) => 'comparado' in f)).toBe(false);
  });

  it('flujo: del disponible inicial al final', () => {
    const f = flujoDirecto(
      [
        {
          netoCaja: 500,
          contrapartidas: [{ codigo: '130505', neto: -500, concepto: null }],
        },
      ],
      100,
      600,
    );
    expect(filasFlujo(f).map((x) => [x.nivel, x.etiqueta, x.actual])).toEqual([
      ['subtotal', 'Disponible al empezar', 100],
      ['grupo', 'Actividades de operación', 500],
      ['cuenta', 'Cobros a clientes', 500],
      ['subtotal', 'Aumento (disminución) del disponible', 500],
      ['total', 'Disponible al terminar', 600],
    ]);
  });

  it('el Excel lleva cifras y la variación como fracción', () => {
    const sep = estadoDeResultados([mov('413595', 0, 1_500)]);
    const ago = estadoDeResultados([mov('413595', 0, 1_000)]);
    const libro = libroEstado(
      'RESULTADOS',
      filasResultados(sep, ago),
      [],
      { actual: 'sep', comparado: 'ago' },
      [],
    );
    expect(libro.tablas[0].filas[0]).toEqual([
      'Grupo',
      null,
      'Ingresos operacionales',
      1_500,
      1_000,
      0.5,
    ]);
    expect(libro.tablas[0].conTotales).toBe(false);
    expect(variacionDe(10, 0)).toBeNull();
  });
});
