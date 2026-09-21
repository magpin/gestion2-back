import ExcelJS from 'exceljs';

import { libroVentas } from '../reportes/libros';
import type { FacturaLeida } from '../reportes/ventas-por-cliente';
import { ExcelService } from './excel.service';

const f = (
  cliente: string,
  numero: string,
  fecha: string,
  total: number,
  pagado: number,
): FacturaLeida => ({
  cliente,
  clienteDocumento: '900123456-8',
  numero,
  fecha,
  estado: 'EMITIDA',
  total: total.toFixed(2),
  pagado: pagado.toFixed(2),
});

/** Escribe el libro y lo vuelve a leer: lo que importa es lo que abre Excel. */
async function idaYVuelta(): Promise<ExcelJS.Workbook> {
  const libro = libroVentas(
    [
      f(
        'Constructora Meridiano',
        'FV-1033',
        '2026-09-04',
        7_600_000,
        7_600_000,
      ),
      f('Almacenes del Sur', 'FV-1038', '2026-09-12', 5_100_000, 0),
    ],
    { desde: '2026-09-01', hasta: '2026-09-30', etiqueta: 'este mes' },
  );
  const buffer = await new ExcelService().escribir(libro, {
    razonSocial: 'Distribuidora Andina S.A.S.',
    nit: '901234567',
    dv: '8',
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('el archivo de Excel', () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    wb = await idaYVuelta();
  });

  it('trae el resumen primero y después los datos', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Resumen',
      'Facturas',
      'Por cliente',
    ]);
    const resumen = wb.getWorksheet('Resumen')!;
    expect(resumen.getCell('A1').value).toBe('Ventas del mes por cliente');
    expect(resumen.getCell('A2').value).toBe(
      'Distribuidora Andina S.A.S. · NIT 901234567-8',
    );
  });

  it('la cabecera queda fija y con autofiltro', () => {
    const hoja = wb.getWorksheet('Facturas')!;
    expect(hoja.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(hoja.autoFilter).toBeDefined();
    expect(hoja.getCell('A1').value).toBe('Cliente');
  });

  it('las cifras son números con formato de pesos, y las fechas son fechas', () => {
    const hoja = wb.getWorksheet('Facturas')!;
    const total = hoja.getCell('G2');
    expect(total.value).toBe(7_600_000);
    expect(total.numFmt).toBe('"$" #,##0');
    const fecha = hoja.getCell('D2').value as Date;
    expect(fecha).toBeInstanceOf(Date);
    expect(fecha.toISOString().slice(0, 10)).toBe('2026-09-04');
  });

  it('el total es un SUBTOTAL, que al filtrar suma lo que se ve', () => {
    const hoja = wb.getWorksheet('Facturas')!;
    const celda = hoja.getCell('G4').value as ExcelJS.CellFormulaValue;
    expect(celda.formula).toBe('SUBTOTAL(109,G2:G3)');
    expect(celda.result).toBe(12_700_000);
    expect(hoja.getCell('A4').value).toBe('Total');
  });
});
