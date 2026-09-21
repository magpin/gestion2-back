import {
  consultaFilas,
  consultaTotales,
  DefinicionInvalida,
  validar,
  type Definicion,
} from './armador';
import { ATAJOS } from './rango';

const RANGO = { desde: '2026-08-01', hasta: '2026-08-31' };

const base = (cambios: Record<string, unknown> = {}) => ({
  origen: 'VENTAS',
  columnas: ['fecha', 'cliente', 'total'],
  fechas: { atajo: 'MES_PASADO' },
  filtros: [],
  agrupar: [],
  ...cambios,
});

const ok = (cambios: Record<string, unknown> = {}): Definicion =>
  validar(base(cambios), ATAJOS);
const rechaza = (cambios: Record<string, unknown>, mensaje: RegExp) =>
  expect(() => validar(base(cambios), ATAJOS)).toThrow(mensaje);

describe('el armador', () => {
  describe('valida contra el catálogo', () => {
    it('acepta una definición bien armada', () => {
      expect(ok()).toMatchObject({
        origen: 'VENTAS',
        columnas: ['fecha', 'cliente', 'total'],
      });
    });

    it('rechaza un origen que no existe', () => {
      rechaza({ origen: 'NOMINA' }, /origen no existe/);
    });

    it('rechaza una columna que no es del origen', () => {
      // `proveedor` es de compras: los orígenes no se cruzan.
      rechaza(
        { columnas: ['fecha', 'proveedor'] },
        /no es una columna de ventas/,
      );
    });

    it('rechaza SQL disfrazado de columna', () => {
      rechaza(
        { columnas: ['fecha; DROP TABLE venta_documento'] },
        DefinicionInvalida as never,
      );
    });

    it('agrupa hasta en dos niveles, no tres', () => {
      rechaza({ agrupar: ['cliente', 'estado', 'tipo'] }, /dos niveles/);
    });

    it('no agrupa por un monto', () => {
      rechaza({ agrupar: ['total'] }, /No se puede agrupar por «Total»/);
    });

    it('agrega la columna de agrupación si faltaba, adelante', () => {
      expect(ok({ agrupar: ['estado'] }).columnas).toEqual([
        'estado',
        'fecha',
        'cliente',
        'total',
      ]);
    });

    it('el rango de fechas es obligatorio', () => {
      rechaza({ fechas: undefined }, /Falta el rango de fechas/);
      rechaza(
        { fechas: { desde: '2026-09-01', hasta: '2026-08-01' } },
        /antes que/,
      );
      rechaza({ fechas: { atajo: 'AYER' } }, /atajo/);
    });

    it('cada columna se filtra solo de la forma que admite', () => {
      rechaza(
        { filtros: [{ columna: 'cliente', forma: 'RANGO', minimo: 1 }] },
        /no se filtra así/,
      );
      rechaza(
        { filtros: [{ columna: 'numero', forma: 'LISTA', valores: ['x'] }] },
        /no se filtra así/,
      );
    });

    it('una lista cerrada solo acepta sus valores', () => {
      rechaza(
        {
          filtros: [
            { columna: 'estado', forma: 'LISTA', valores: ['BORRADA'] },
          ],
        },
        /no tiene ese valor/,
      );
      expect(
        ok({
          filtros: [
            { columna: 'estado', forma: 'LISTA', valores: ['ANULADA'] },
          ],
        }).filtros,
      ).toHaveLength(1);
    });

    it('un rango de números necesita al menos un borde, y en orden', () => {
      rechaza(
        { filtros: [{ columna: 'total', forma: 'RANGO' }] },
        /ni mínimo ni máximo/,
      );
      rechaza(
        {
          filtros: [
            { columna: 'total', forma: 'RANGO', minimo: 10, maximo: 5 },
          ],
        },
        /mínimo es mayor/,
      );
    });
  });

  describe('arma SQL con parámetros', () => {
    it('lo que viene del cliente va como parámetro, nunca en el texto', () => {
      const cliente = "O'Brien'); DROP TABLE tercero; --";
      const def = ok({
        filtros: [
          { columna: 'cliente', forma: 'LISTA', valores: [cliente] },
          { columna: 'total', forma: 'RANGO', minimo: 1000, maximo: 5000 },
        ],
      });
      const q = consultaFilas(def, RANGO, 50);
      expect(q.sql).not.toContain('DROP');
      expect(q.sql).not.toContain('1000');
      expect(q.parametros).toEqual([
        '2026-08-01',
        '2026-08-31',
        [cliente],
        1000,
        5000,
      ]);
      expect(q.sql).toContain('= ANY($3::text[])');
      expect(q.sql).toContain('>= $4::numeric');
      expect(q.sql).toContain('<= $5::numeric');
    });

    it('pide una fila de más para saber si hay más', () => {
      expect(consultaFilas(ok(), RANGO, 50).sql).toMatch(/LIMIT 51$/);
    });

    it('ordena primero por los grupos y después por lo elegido', () => {
      const q = consultaFilas(
        ok({
          agrupar: ['cliente'],
          orden: { columna: 'total', direccion: 'DESC' },
        }),
        RANGO,
        50,
      );
      const orden = q.sql.slice(q.sql.indexOf('ORDER BY'));
      expect(orden.indexOf('t.razon_social')).toBeLessThan(
        orden.indexOf('v.total DESC'),
      );
    });

    it('la cartera trae siempre su condición fija', () => {
      const q = consultaFilas(
        ok({ origen: 'CARTERA', columnas: ['cliente', 'saldo'] }),
        RANGO,
        50,
      );
      expect(q.sql).toContain("v.tipo <> 'COTIZACION'");
      expect(q.sql).toContain('v.total - v.monto_pagado > 0');
    });

    it('sí o no se compara con «Sí» o «No», como parámetro', () => {
      const def = ok({
        origen: 'CARTERA',
        columnas: ['cliente', 'saldo'],
        filtros: [{ columna: 'vencida', forma: 'SI_NO', valor: true }],
      });
      expect(consultaFilas(def, RANGO, 50).parametros).toContain('Sí');
    });
  });

  describe('los totales', () => {
    it('sin grupos, un total y nada más', () => {
      const q = consultaTotales(ok(), RANGO);
      expect(q.sql).not.toContain('GROUPING');
      expect(q.sql).toContain('SUM(v.total)');
    });

    it('con dos grupos: el total, el de cada grupo y el de cada subgrupo', () => {
      const q = consultaTotales(ok({ agrupar: ['cliente', 'estado'] }), RANGO);
      // El nombre del tercero ocupa varias líneas: de ahí la `s`.
      expect(q.sql).toMatch(/GROUPING SETS \(\(\), \(.+\), \(.+, .+\)\)/s);
      expect(q.sql).toContain('AS nivel');
    });

    it('solo suman las cifras que suman: no la fecha, no un saldo de kardex', () => {
      const q = consultaTotales(
        ok({
          origen: 'INVENTARIO',
          columnas: ['fecha', 'producto', 'cantidad', 'saldoCantidad'],
        }),
        RANGO,
      );
      expect(q.sql).toContain('SUM(m.cantidad)');
      expect(q.sql).not.toContain('SUM(m.saldo_cantidad)');
      expect(q.sql).not.toContain('SUM(m.fecha)');
    });
  });
});
