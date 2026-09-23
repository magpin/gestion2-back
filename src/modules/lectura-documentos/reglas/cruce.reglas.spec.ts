import {
  codigoDelRenglon,
  comparable,
  consolidar,
  elegirCuenta,
  elegirProducto,
  elegirProveedor,
  mismoNit,
  type LineaCruzada,
} from './cruce.reglas';

const producto = (codigo: string, nombre: string) => ({
  id: `id-${codigo}`,
  codigo,
  nombre,
});

const renglon = (descripcion: string, codigo: string | null = null) => ({
  codigo,
  descripcion,
});

describe('comparable — el mismo producto escrito de dos formas', () => {
  it('ignora tildes, mayúsculas y espacios de más', () => {
    expect(comparable('  Tinta HP  664  Negra ')).toBe('TINTA HP 664 NEGRA');
    expect(comparable('Cañón')).toBe(comparable('CANON'));
  });

  // Normalizar puntuación empezaría a acercar cosas que no son iguales, y lo
  // que sigue a la coincidencia exacta es «preguntá», no «aproximá».
  it('no toca la puntuación', () => {
    expect(comparable('MOUSE - INALAMBRICO')).not.toBe(
      comparable('MOUSE INALAMBRICO'),
    );
  });
});

describe('codigoDelRenglon — el código pegado al nombre', () => {
  it('usa la columna cuando existe', () => {
    expect(codigoDelRenglon(renglon('TINTA HP', 'P001'))).toBe('P001');
  });

  // Así lo exporta el sistema anterior: «P27ORI0018 TINTA …».
  it('cuando no hay columna, prueba con la primera palabra', () => {
    expect(codigoDelRenglon(renglon('P27ORI0018 TINTA HP 664'))).toBe(
      'P27ORI0018',
    );
  });

  it('no toma por código una palabra sin dígitos', () => {
    expect(codigoDelRenglon(renglon('TINTA HP NEGRA'))).toBeNull();
  });

  it('no toma por código algo demasiado corto', () => {
    expect(codigoDelRenglon(renglon('A1 TINTA'))).toBeNull();
  });
});

describe('elegirProducto — elegir, y sobre todo no elegir', () => {
  it('por código exacto', () => {
    const c = elegirProducto(renglon('TINTA HP 664', 'P001'), [
      producto('P001', 'TINTA HP 664 NEGRA'),
      producto('P002', 'TINTA HP 664 COLOR'),
    ]);
    expect(c.encontrado?.id).toBe('id-P001');
    expect(c.forma).toBe('CODIGO');
  });

  it('por nombre exacto, sin tildes ni mayúsculas', () => {
    const c = elegirProducto(renglon('tinta hp 664 negra'), [
      producto('P001', 'TINTA HP 664 NEGRA'),
      producto('P002', 'TINTA HP 664 NEGRA XL'),
    ]);
    expect(c.encontrado?.id).toBe('id-P001');
    expect(c.forma).toBe('NOMBRE_EXACTO');
  });

  it('cuando la búsqueda devuelve uno solo, ese es — pero se dice cómo', () => {
    const c = elegirProducto(renglon('TINTA NEGRA CHICA'), [
      producto('P001', 'TINTA HP 664 NEGRA'),
    ]);
    expect(c.encontrado?.id).toBe('id-P001');
    expect(c.forma).toBe('UNICA_COINCIDENCIA');
  });

  // Lo que importa: un producto equivocado entra al kardex y sale en el costo
  // de todo lo que se venda después.
  it('con varios parecidos no elige ninguno, y dice cuántos hay', () => {
    const c = elegirProducto(renglon('TINTA'), [
      producto('P001', 'TINTA HP 664 NEGRA'),
      producto('P002', 'TINTA HP 664 COLOR'),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('2 productos parecidos');
  });

  it('sin coincidencias, lo dice sin rodeos', () => {
    const c = elegirProducto(renglon('TINTA'), []);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('No encontré');
  });

  it('dos productos con el mismo nombre son un problema del catálogo, no una elección', () => {
    const c = elegirProducto(renglon('TINTA HP 664 NEGRA'), [
      producto('P001', 'TINTA HP 664 NEGRA'),
      producto('P009', 'Tinta HP 664 Negra'),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('mismo nombre');
  });
});

describe('mismoNit — el dígito de verificación pegado', () => {
  it('iguales', () => {
    expect(mismoNit('900378652', '900378652')).toBe(true);
  });

  it('el leído trae el dígito de verificación pegado', () => {
    expect(mismoNit('900378652', '9003786521')).toBe(true);
    expect(mismoNit('900378652', '900.378.652-1')).toBe(true);
  });

  // Dos NIT que difieren en un dígito del medio no son el mismo.
  it('distintos no pasan', () => {
    expect(mismoNit('900378652', '900378653')).toBe(false);
    expect(mismoNit('900378652', '90037865')).toBe(true); // uno menos: prefijo
    expect(mismoNit('900378652', '9003786')).toBe(false); // dos menos: no
  });

  it('vacío nunca coincide', () => {
    expect(mismoNit('', '900378652')).toBe(false);
  });
});

describe('elegirProveedor — por NIT o se pregunta', () => {
  const tercero = (numeroDocumento: string, esProveedor = true) => ({
    id: 'id-t',
    numeroDocumento,
    nombre: 'JALTECH SOLUCIONES S.A.S.',
    esProveedor,
  });

  it('por NIT', () => {
    const c = elegirProveedor({ nombre: 'JALTECH', nit: '900378652' }, [
      tercero('900378652'),
    ]);
    expect(c.encontrado?.id).toBe('id-t');
    expect(c.forma).toBe('NIT');
  });

  // Dos empresas casi homónimas y la compra le queda a la cuenta por pagar de
  // la equivocada.
  it('sin NIT no se elige por nombre, aunque haya una sola', () => {
    const c = elegirProveedor(
      { nombre: 'JALTECH SOLUCIONES S.A.S.', nit: null },
      [tercero('900378652')],
    );
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('no trae el NIT');
  });

  it('si no está, propone crearlo', () => {
    const c = elegirProveedor({ nombre: 'X', nit: '900111222' }, []);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('¿Lo creo como proveedor?');
  });

  // Existe pero le falta un dato: se arregla distinto, así que se dice distinto.
  it('existe pero no está marcado como proveedor', () => {
    const c = elegirProveedor({ nombre: 'X', nit: '900378652' }, [
      tercero('900378652', false),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('no figura como proveedor');
  });
});

describe('elegirCuenta — solo por código, y casi nunca hay uno', () => {
  const cuenta = (codigo: string, esAuxiliar = true) => ({
    id: `id-${codigo}`,
    codigo,
    nombre: 'Arrendamientos',
    esAuxiliar,
  });

  it('por código exacto', () => {
    const c = elegirCuenta({ cuentaPuc: '512005', descripcion: 'ARRIENDO' }, [
      cuenta('512005'),
    ]);
    expect(c.encontrado?.id).toBe('id-512005');
  });

  // El caso real del 23 de septiembre: el arriendo se leyó bien y se frenó acá.
  it('sin código impreso, se pregunta', () => {
    const c = elegirCuenta(
      { cuentaPuc: null, descripcion: 'ARRENDAMIENTO LOCAL COMERCIAL' },
      [cuenta('512005')],
    );
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('¿Cuál uso?');
  });

  it('una cuenta de agrupación no recibe movimientos', () => {
    const c = elegirCuenta({ cuentaPuc: '5120', descripcion: 'X' }, [
      cuenta('5120', false),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('agrupación');
  });

  // La clase 1 entera dejaría mandar un arriendo a un banco.
  it('una cuenta de banco no es una cuenta de gasto', () => {
    const c = elegirCuenta({ cuentaPuc: '111005', descripcion: 'X' }, [
      cuenta('111005'),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('no es de gasto');
  });

  it('una cuenta que no está en el plan', () => {
    const c = elegirCuenta({ cuentaPuc: '512005', descripcion: 'X' }, []);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('no está en el plan');
  });
});

describe('consolidar — el mismo producto dos veces', () => {
  const linea = (
    productoId: string,
    cantidad: number,
    valor: number,
  ): LineaCruzada => ({
    productoId,
    cantidad,
    costoUnitario: valor / cantidad,
    valor,
  });

  it('junta y deja el costo al promedio ponderado', () => {
    const r = consolidar([linea('p1', 2, 20_000), linea('p1', 3, 45_000)]);
    expect(r.lineas).toHaveLength(1);
    expect(r.juntadas).toBe(1);
    expect(r.lineas[0].cantidad).toBe(5);
    expect(r.lineas[0].costoUnitario).toBe(13_000);
    // La línea sigue sumando su propio valor: 5 × 13.000 = 65.000.
    expect(r.lineas[0].cantidad * r.lineas[0].costoUnitario).toBe(65_000);
  });

  it('no toca lo que no se repite', () => {
    const r = consolidar([linea('p1', 1, 100), linea('p2', 1, 200)]);
    expect(r.lineas).toHaveLength(2);
    expect(r.juntadas).toBe(0);
  });

  // Dos renglones de «mantenimiento» contra la misma cuenta pueden ser dos
  // servicios distintos, y el detalle es lo que los diferencia en el libro.
  it('los gastos nunca se juntan, ni contra la misma cuenta', () => {
    const gasto = (detalle: string): LineaCruzada => ({
      cuentaId: 'c1',
      detalle,
      ivaTarifa: 19,
      cantidad: 1,
      costoUnitario: 100,
      valor: 100,
    });
    const r = consolidar([
      gasto('mantenimiento del aire'),
      gasto('mantenimiento del ascensor'),
    ]);
    expect(r.lineas).toHaveLength(2);
    expect(r.juntadas).toBe(0);
  });
});
