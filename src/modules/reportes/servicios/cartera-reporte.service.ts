import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { armar, type AntiguedadCartera } from '../reportes/antiguedad-cartera';
import { libroCartera } from '../reportes/libros';
import {
  DIAS_PARA_VENCER,
  type FacturaLeida,
} from '../reportes/ventas-por-cliente';
import { ExcelService } from './excel.service';
import type { Assets } from './gotenberg.service';
import { GotenbergService } from './gotenberg.service';
import { MembreteService } from './membrete.service';
import { PlantillaService, type Destino } from './plantilla.service';

/**
 * «Antigüedad de saldos de cartera»: de la base al PDF.
 *
 * **No usa gráficos de QuickChart y no le falta ninguno.** Las dos figuras de
 * la hoja —la franja de rangos y las barras por cliente— son cajas con ancho
 * proporcional, y en HTML salen exactas, se imprimen nítidas a cualquier
 * tamaño y no dependen de que otro contenedor esté arriba. Una imagen acá sería
 * más frágil y se vería peor.
 */
@Injectable()
export class CarteraReporteService {
  constructor(
    private readonly tx: TxService,
    private readonly plantillas: PlantillaService,
    private readonly gotenberg: GotenbergService,
    private readonly membretes: MembreteService,
    private readonly excel: ExcelService,
  ) {}

  /**
   * Las facturas con saldo **a la fecha de corte**.
   *
   * El filtro por saldo va en el armador y no acá a propósito: una factura con
   * `monto_pagado` igual al total hoy pudo tener saldo en la fecha de corte, y
   * el día que el sistema guarde el historial de pagos esta consulta va a poder
   * mirarlo. Traer de más y descartar en memoria es reversible; filtrar en el
   * `WHERE` esconde el problema.
   *
   * **Sin límite inferior de fecha**: la cartera no es de un mes, es todo lo que
   * está sin cobrar desde que la empresa existe. Una factura de hace dos años
   * con saldo es exactamente lo que este reporte viene a mostrar.
   */
  private async pendientes(
    ctx: CtxEmpresa,
    corte: string,
  ): Promise<FacturaLeida[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const crudas = await t.query<Array<Record<string, unknown>>>(
        `SELECT COALESCE(NULLIF(BTRIM(t.razon_social), ''),
                  BTRIM(CONCAT_WS(' ', t.primer_nombre, t.segundo_nombre,
                                  t.primer_apellido, t.segundo_apellido))) AS cliente,
                CONCAT(t.numero_documento,
                       CASE WHEN t.dv IS NOT NULL THEN CONCAT('-', t.dv) ELSE '' END)
                  AS "clienteDocumento",
                CONCAT_WS('-', v.prefijo, v.consecutivo::text) AS numero,
                TO_CHAR(v.fecha, 'YYYY-MM-DD') AS fecha,
                v.estado,
                v.total::text AS total,
                v.monto_pagado::text AS pagado
           FROM venta_documento v
           JOIN tercero t ON t.id = v.tercero_id
          WHERE v.fecha <= $1::date
            AND v.tipo <> 'COTIZACION'
            AND v.estado <> 'ANULADA'
          ORDER BY v.fecha`,
        [corte],
      );
      return filas<FacturaLeida>(crudas);
    });
  }

  async armarHoja(
    ctx: CtxEmpresa,
    corte: string,
    quien: { nombre: string; rol: string },
    destino: Destino = 'PDF',
    baseFuentes?: string,
  ): Promise<{ html: string; assets: Assets; datos: AntiguedadCartera }> {
    const [pendientes, empresa] = await Promise.all([
      this.pendientes(ctx, corte),
      this.membretes.de(ctx),
    ]);

    const datos = armar(pendientes, corte, DIAS_PARA_VENCER);

    const cuerpo = this.plantillas.cuerpo('antiguedad-cartera', {
      ...datos,
      elaboro: quien.nombre,
      rol: quien.rol,
    });

    return {
      ...this.plantillas.armar({
        titulo: 'Antigüedad de saldos de cartera',
        parametros: [
          `corte ${corte}`,
          'Cartera por cobrar · saldo mayor a $ 0',
        ],
        empresa,
        elaboro: quien.nombre,
        cuerpo,
        // Horizontal: cinco tramos por cliente no caben legibles en vertical.
        orientacion: 'HORIZONTAL',
        // Una foto del saldo a una fecha no es un documento que se entregue
        // firmado. El de ventas sí lo lleva; este no, como en el diseño.
        conFirmas: false,
        destino,
        baseFuentes,
      }),
      datos,
    };
  }

  async pdf(
    ctx: CtxEmpresa,
    corte: string,
    quien: { nombre: string; rol: string },
  ): Promise<Buffer> {
    const { html, assets } = await this.armarHoja(ctx, corte, quien);
    return this.gotenberg.aPdf(html, assets);
  }

  /**
   * El Excel: las mismas facturas con saldo, una por fila, y el saldo por
   * cliente y tramo. Sin Gotenberg: si el PDF está caído, el Excel sale igual.
   */
  async xlsx(
    ctx: CtxEmpresa,
    corte: { corte: string; etiqueta: string },
  ): Promise<Buffer> {
    const [pendientes, empresa] = await Promise.all([
      this.pendientes(ctx, corte.corte),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(
      libroCartera(pendientes, corte, DIAS_PARA_VENCER),
      empresa,
    );
  }
}
