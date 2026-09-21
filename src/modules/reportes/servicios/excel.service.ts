import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import type { Celda, Libro, TipoColumna } from '../reportes/libros';

/**
 * Cómo se ve cada tipo en Excel.
 *
 * Es **formato, no contenido**: la celda guarda el número y Excel pone los
 * separadores según la configuración de quien abre el archivo. Un contador en
 * Colombia ve `$ 68.575.000`; el mismo archivo abierto con otra configuración
 * regional muestra otros separadores y sigue sumando.
 */
const FORMATO: Record<TipoColumna, string | undefined> = {
  TEXTO: undefined,
  FECHA: 'dd/mm/yyyy',
  DINERO: '"$" #,##0',
  ENTERO: '0',
  PORCIENTO: '0.0%',
};

/** El gris de las cabeceras: el mismo `neutral-100` de la pantalla. */
const CABECERA = 'FFEDEDED';

/**
 * Escribe un `Libro` como `.xlsx`.
 *
 * No decide nada de lo que va adentro —eso es de `reportes/libros.ts`, puro y
 * probado—: solo lo pasa a ExcelJS. Si un día hiciera falta otra librería, se
 * cambia este archivo y nada más.
 *
 * **Sin gráficas.** ExcelJS no hace gráficas nativas, y una imagen pegada no se
 * filtra ni se actualiza: lo que el contador quiere del Excel son los datos, y
 * con los datos arma su gráfica en dos clics. La gráfica ya está en el PDF.
 */
@Injectable()
export class ExcelService {
  async escribir(
    libro: Libro,
    empresa: { razonSocial: string; nit: string; dv?: string },
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = empresa.razonSocial;
    wb.created = new Date();

    this.resumen(wb, libro, empresa);
    for (const tabla of libro.tablas) {
      const hoja = wb.addWorksheet(tabla.nombre.slice(0, 31), {
        // La cabecera queda fija al bajar: con cuatrocientas facturas, nadie
        // se acuerda de cuál era la séptima columna.
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      hoja.columns = tabla.columnas.map((c) => ({
        header: c.titulo,
        width: c.ancho,
        style: FORMATO[c.tipo] ? { numFmt: FORMATO[c.tipo] } : {},
      }));
      this.pintarCabecera(hoja.getRow(1));

      for (const fila of tabla.filas) {
        hoja.addRow(
          fila.map((celda, i) => this.valor(celda, tabla.columnas[i].tipo)),
        );
      }

      const ultima = tabla.filas.length + 1;
      if (tabla.filas.length > 0) {
        hoja.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: 1, column: tabla.columnas.length },
        };
      }

      if (tabla.conTotales) {
        const totales = hoja.addRow([]);
        totales.getCell(1).value = 'Total';
        tabla.columnas.forEach((c, i) => {
          if (!c.suma) return;
          const letra = hoja.getColumn(i + 1).letter;
          const resultado = tabla.filas.reduce((a, f) => {
            const v = f[i];
            return a + (typeof v === 'number' ? v : 0);
          }, 0);
          // `SUBTOTAL(109, …)` y no `SUMA`: al filtrar, suma solo lo que se ve.
          // El resultado va calculado para que el archivo muestre el total
          // aunque se abra en un visor que no recalcula.
          totales.getCell(i + 1).value = {
            formula: `SUBTOTAL(109,${letra}2:${letra}${Math.max(2, ultima)})`,
            result: resultado,
          };
        });
        totales.font = { bold: true };
        totales.border = {
          top: { style: 'thin', color: { argb: 'FF171717' } },
        };
      }
    }

    const salida = await wb.xlsx.writeBuffer();
    return Buffer.from(salida);
  }

  /** La primera pestaña: qué es, de quién, con qué fechas, y las cifras de arriba. */
  private resumen(
    wb: ExcelJS.Workbook,
    libro: Libro,
    empresa: { razonSocial: string; nit: string; dv?: string },
  ): void {
    const hoja = wb.addWorksheet('Resumen');
    hoja.columns = [{ width: 34 }, { width: 22 }];

    hoja.addRow([libro.titulo]).font = { bold: true, size: 14 };
    hoja.addRow([
      `${empresa.razonSocial} · NIT ${empresa.nit}${empresa.dv ? `-${empresa.dv}` : ''}`,
    ]);
    for (const p of libro.parametros) hoja.addRow([p]);
    hoja.addRow([
      `Generado el ${new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'America/Bogota',
      }).format(new Date())}. Los datos son los de ese momento.`,
    ]).font = { color: { argb: 'FF6B6B6B' } };
    hoja.addRow([]);

    for (const r of libro.resumen) {
      const fila = hoja.addRow([r.rotulo, this.valor(r.valor, r.tipo)]);
      const formato = FORMATO[r.tipo];
      if (formato) fila.getCell(2).numFmt = formato;
    }

    if (libro.notas.length > 0) {
      hoja.addRow([]);
      hoja.addRow(['Para leer bien los números']).font = { bold: true };
      for (const n of libro.notas) hoja.addRow([n]);
    }
  }

  private pintarCabecera(fila: ExcelJS.Row): void {
    fila.font = { bold: true };
    fila.alignment = { vertical: 'middle', wrapText: true };
    fila.eachCell((celda) => {
      celda.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: CABECERA },
      };
      celda.border = { bottom: { style: 'thin', color: { argb: 'FF171717' } } };
    });
  }

  /**
   * Una fecha `aaaa-mm-dd` se escribe como fecha **UTC**: con la hora local, un
   * servidor al oeste de Greenwich la corre al día anterior.
   */
  private valor(celda: Celda, tipo: TipoColumna): ExcelJS.CellValue {
    if (celda === null) return null;
    if (tipo === 'FECHA' && typeof celda === 'string') {
      const [a, m, d] = celda.split('-').map(Number);
      return new Date(Date.UTC(a, m - 1, d));
    }
    return celda;
  }
}
