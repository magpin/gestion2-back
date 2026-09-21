import { armar as armarCartera } from './antiguedad-cartera';
import { libroCartera, libroVentas, type Libro } from './libros';
import {
  armar as armarVentas,
  millones,
  pesos,
  type FacturaLeida,
} from './ventas-por-cliente';

/**
 * Lo que importa del Excel: **que diga lo mismo que la hoja**. Por eso las
 * pruebas no repiten cifras a mano; comparan contra lo que arma el PDF con las
 * mismas facturas.
 */
const f = (
  cliente: string,
  numero: string,
  fecha: string,
  total: number,
  pagado: number,
  estado: 'EMITIDA' | 'ANULADA' = 'EMITIDA',
): FacturaLeida => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado,
  total: total.toFixed(2),
  pagado: pagado.toFixed(2),
});

const FACTURAS: FacturaLeida[] = [
  f('Constructora Meridiano', 'FV-1033', '2026-09-04', 7_600_000, 7_600_000),
  f('Constructora Meridiano', 'FV-1046', '2026-09-20', 7_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1038', '2026-08-12', 5_100_000, 0),
  f('Almacenes del Sur S.A.S.', 'FV-1042', '2026-09-18', 8_930_000, 1_000_000),
  f('Ferretería El Tornillo', 'FV-1040', '2026-09-16', 3_480_000, 2_280_000),
  f('Ferretería El Tornillo', 'FV-1039', '2026-09-10', 900_000, 0, 'ANULADA'),
];

const RANGO = {
  desde: '2026-08-01',
  hasta: '2026-09-30',
  etiqueta: 'fechas fijas',
};

const valor = (libro: Libro, rotulo: string) =>
  libro.resumen.find((r) => r.rotulo === rotulo)?.valor;
const tabla = (libro: Libro, nombre: string) =>
  libro.tablas.find((t) => t.nombre === nombre);
const sumaColumna = (libro: Libro, nombre: string, titulo: string) => {
  const t = tabla(libro, nombre);
  const i = t?.columnas.findIndex((c) => c.titulo === titulo) ?? -1;
  return (t?.filas ?? []).reduce((a, fila) => a + (fila[i] as number), 0);
};

describe('el Excel de ventas', () => {
  const libro = libroVentas(FACTURAS, RANGO);
  const hoja = armarVentas(FACTURAS, RANGO);

  it('el resumen dice lo mismo que la hoja', () => {
    const enPesos = (v: unknown) => pesos(Math.round((v as number) * 100));
    expect(enPesos(valor(libro, 'Total facturado'))).toBe(
      hoja.resumen.totalFacturado,
    );
    // La hoja escribe estas tres en millones; el Excel, el número entero.
    const enMillones = (v: unknown) =>
      millones(Math.round((v as number) * 100));
    expect(enMillones(valor(libro, 'Cobrado'))).toBe(hoja.resumen.cobrado);
    expect(enMillones(valor(libro, 'Por cobrar'))).toBe(hoja.resumen.porCobrar);
    expect(enMillones(valor(libro, 'Vencido'))).toBe(hoja.resumen.vencido);
    expect(valor(libro, 'Facturas')).toBe(hoja.resumen.facturas);
    expect(valor(libro, 'Clientes')).toBe(hoja.resumen.clientes);
  });

  it('una fila por factura, y las filas suman el resumen', () => {
    expect(tabla(libro, 'Facturas')?.filas).toHaveLength(5);
    expect(sumaColumna(libro, 'Facturas', 'Total')).toBe(
      valor(libro, 'Total facturado'),
    );
    expect(sumaColumna(libro, 'Por cliente', 'Por cobrar')).toBe(
      valor(libro, 'Por cobrar'),
    );
  });

  it('las cifras van en pesos y como números, no como texto', () => {
    const fila = tabla(libro, 'Facturas')?.filas[0] ?? [];
    expect(fila[6]).toBe(7_600_000);
    expect(typeof fila[6]).toBe('number');
    expect(fila[3]).toBe('2026-09-04');
  });

  it('las anuladas no suman: van en su pestaña', () => {
    expect(
      tabla(libro, 'Facturas')?.filas.some((r) => r[2] === 'FV-1039'),
    ).toBe(false);
    expect(tabla(libro, 'Anuladas')?.filas).toEqual([
      [
        'Ferretería El Tornillo',
        '900123456-8',
        'FV-1039',
        '2026-09-10',
        900_000,
      ],
    ]);
  });

  it('sin anuladas no hay pestaña de anuladas', () => {
    expect(
      tabla(libroVentas(FACTURAS.slice(0, 2), RANGO), 'Anuladas'),
    ).toBeUndefined();
  });

  it('la vencida es la de más de treinta días con saldo, como en la hoja', () => {
    const vencida = tabla(libro, 'Facturas')?.filas.find(
      (r) => r[2] === 'FV-1038',
    );
    expect(vencida?.[5]).toBe('Vencida');
  });
});

describe('el Excel de cartera', () => {
  const corte = { corte: '2026-09-21', etiqueta: 'hoy' };
  const libro = libroCartera(FACTURAS, corte, 30);
  const hoja = armarCartera(FACTURAS, corte.corte, 30);

  it('cada tramo suma lo mismo que en la hoja', () => {
    for (const t of hoja.tramos) {
      const columna = tabla(libro, 'Por cliente')?.columnas.find((c) =>
        c.titulo.startsWith(t.etiqueta),
      );
      expect(columna).toBeDefined();
      expect(sumaColumna(libro, 'Por cliente', columna!.titulo)).toBe(
        t.centavos / 100,
      );
    }
  });

  it('solo entran facturas con saldo, y ninguna anulada', () => {
    const numeros = tabla(libro, 'Facturas')?.filas.map((r) => r[2]);
    expect(numeros).not.toContain('FV-1033'); // pagada
    expect(numeros).not.toContain('FV-1039'); // anulada
    expect(numeros).toHaveLength(4);
  });

  it('los días vencidos restan el plazo y no bajan de cero', () => {
    const agosto = tabla(libro, 'Facturas')?.filas.find(
      (r) => r[2] === 'FV-1038',
    );
    // Del 12 de agosto al 21 de septiembre son 40 días; con 30 de plazo, 10 vencida.
    expect(agosto?.[4]).toBe(40);
    expect(agosto?.[5]).toBe(10);
    expect(agosto?.[6]).toBe('1 – 30 días');
    const reciente = tabla(libro, 'Facturas')?.filas.find(
      (r) => r[2] === 'FV-1046',
    );
    expect(reciente?.[5]).toBe(0);
  });

  it('la cartera total es la suma de los saldos', () => {
    expect(valor(libro, 'Cartera total')).toBe(
      sumaColumna(libro, 'Facturas', 'Saldo'),
    );
  });
});
