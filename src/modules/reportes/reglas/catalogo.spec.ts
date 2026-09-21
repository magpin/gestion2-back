import {
  columnaDe,
  ORIGENES,
  origenesPara,
  SUMA,
  type ClaveOrigen,
  type Origen,
} from './catalogo';

const TODOS = Object.values(ORIGENES);
const PARES: Array<[ClaveOrigen, Origen]> = TODOS.map((o) => [o.clave, o]);

/**
 * Lo que se vigila acá no es que el catálogo tenga tal columna: es que cumpla
 * las reglas que lo hacen seguro y usable. Que el SQL además **exista** contra
 * la base es otra cosa y la prueba `scripts/verificar-catalogo-reportes.js`,
 * que necesita una base viva y por eso no vive en esta suite.
 */
describe('el catálogo de reportes', () => {
  it('tiene seis orígenes y ni uno más', () => {
    expect(TODOS).toHaveLength(6);
  });

  it.each(PARES)('%s se declara con su propia clave', (clave, origen) => {
    // Un origen cuya clave no coincide con la del mapa haría que `ORIGENES[x]`
    // devuelva algo que dice llamarse `y`, y el servicio confía en `clave`.
    expect(origen.clave).toBe(clave);
  });

  it.each(PARES)('%s no repite claves de columna', (_clave, origen) => {
    const claves = origen.columnas.map((c) => c.clave);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it.each(PARES)('%s tiene al menos una columna inicial', (_clave, origen) => {
    // Sin columnas iniciales no hay «reporte del que se parte», y la pantalla
    // arrancaría en blanco — justo lo que la primera decisión del plan descartó.
    expect(origen.columnas.some((c) => c.inicial === true)).toBe(true);
  });

  it.each(PARES)('%s dice con qué fecha se filtra', (_clave, origen) => {
    expect(origen.fecha.trim()).not.toBe('');
  });

  it.each(PARES)('%s se lo puede correr alguien', (_clave, origen) => {
    expect(origen.roles.length).toBeGreaterThan(0);
  });

  describe('las reglas de cada columna', () => {
    const COLUMNAS = TODOS.flatMap((o) =>
      o.columnas.map((c) => [`${o.clave}.${c.clave}`, c] as const),
    );

    it.each(COLUMNAS)('%s trae SQL', (_nombre, columna) => {
      expect(columna.sql.trim()).not.toBe('');
    });

    it.each(COLUMNAS)('%s trae etiqueta propia', (_nombre, columna) => {
      // La etiqueta es nuestra, no de la base: si alguien deja la clave como
      // etiqueta, la pantalla muestra `clienteDocumento` en vez de «NIT».
      expect(columna.etiqueta.trim()).not.toBe('');
      expect(columna.etiqueta).not.toBe(columna.clave);
    });

    it.each(COLUMNAS)('%s no agrupa por un monto', (_nombre, columna) => {
      // Agrupar por «total» arma un grupo por cada cifra distinta: tantos
      // grupos como filas, y ninguno significa nada.
      if (SUMA[columna.tipo]) expect(columna.agrupable).not.toBe(true);
    });

    it.each(COLUMNAS)(
      '%s filtra de una forma coherente',
      (_nombre, columna) => {
        if (columna.filtro === 'LISTA') {
          // Una lista saca sus valores de un lado o del otro, nunca de los dos ni
          // de ninguno: sin eso la pantalla no sabe qué ofrecer.
          const cerrada = columna.valores !== undefined;
          const abierta = columna.catalogo !== undefined;
          expect(cerrada !== abierta).toBe(true);
        } else {
          expect(columna.valores).toBeUndefined();
          expect(columna.catalogo).toBeUndefined();
        }

        // Un rango sobre texto no tiene sentido; una fecha ya la filtra el rango
        // obligatorio del origen.
        if (columna.filtro === 'RANGO') expect(SUMA[columna.tipo]).toBe(true);
      },
    );
  });

  describe('quién ve qué', () => {
    it('un VENTAS no puede correr compras', () => {
      const suyos = origenesPara(['VENTAS']).map((o) => o.clave);
      expect(suyos).toContain('VENTAS');
      expect(suyos).not.toContain('COMPRAS');
      expect(suyos).not.toContain('CONTABILIDAD');
    });

    it('un CONTADOR los corre todos', () => {
      expect(origenesPara(['CONTADOR'])).toHaveLength(6);
    });

    it('sin roles no se corre ninguno', () => {
      expect(origenesPara([])).toEqual([]);
    });

    it('con dos roles se suman, no se restan', () => {
      const suyos = origenesPara(['VENTAS', 'COMPRAS']).map((o) => o.clave);
      expect(suyos).toEqual(expect.arrayContaining(['VENTAS', 'COMPRAS']));
    });
  });

  describe('la única puerta', () => {
    it('devuelve la columna que existe', () => {
      expect(columnaDe('VENTAS', 'total')?.tipo).toBe('DINERO');
    });

    it('no devuelve nada para una clave inventada', () => {
      // Es la línea que separa «elegir columnas» de una inyección de SQL: sin
      // `sql` no hay nada que interpolar.
      expect(
        columnaDe('VENTAS', 'total; DROP TABLE venta_documento'),
      ).toBeUndefined();
    });

    it('no devuelve una columna de otro origen', () => {
      expect(columnaDe('VENTAS', 'debito')).toBeUndefined();
      expect(columnaDe('CONTABILIDAD', 'debito')).toBeDefined();
    });
  });
});
