import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { TxService } from '../../../common/db/tx.service';
import { filas } from '../../../common/db/filas';
import {
  armar,
  DIAS_PARA_VENCER,
  type FacturaLeida,
  type VentasPorCliente,
} from '../reportes/ventas-por-cliente';
import { libroVentas } from '../reportes/libros';
import { ExcelService } from './excel.service';
import type { Assets } from './gotenberg.service';
import { GotenbergService } from './gotenberg.service';
import { GraficoService, TINTA } from './grafico.service';
import { MembreteService } from './membrete.service';
import { PlantillaService, type Destino } from './plantilla.service';

export interface Rango {
  desde: string;
  hasta: string;
  /**
   * Cómo se eligió el rango. Va impreso, porque **decide si la hoja sirve
   * dentro de seis meses**: «este mes» vuelve a correr sobre otro mes, una
   * fecha escrita a mano vuelve sobre la misma.
   */
  etiqueta: string;
}

/**
 * «Ventas del mes por cliente»: de la base al PDF.
 *
 * El reparto es a propósito: la **consulta** está acá, las **cuentas** están en
 * `reportes/ventas-por-cliente.ts` —puras, con prueba contra los números del
 * diseño— y el **dibujo** en la plantilla. Ninguna de las tres sabe hacer el
 * trabajo de las otras, que es lo que permite comprobar las cuentas sin
 * levantar una base ni un contenedor.
 */
@Injectable()
export class VentasReporteService {
  constructor(
    private readonly tx: TxService,
    private readonly membretes: MembreteService,
    private readonly plantillas: PlantillaService,
    private readonly graficos: GraficoService,
    private readonly gotenberg: GotenbergService,
    private readonly excel: ExcelService,
  ) {}

  /**
   * Las facturas del rango, con su cliente.
   *
   * **Las cotizaciones no entran**: una cotización no es una venta, y sumarla
   * sería reportar plata que nadie debe. Las anuladas **sí** entran, porque el
   * armador las muestra tachadas —su número se consumió y alguien va a
   * preguntar por él— aunque no las sume.
   *
   * El contexto de empresa lo pone `enContexto`, y con él el RLS: esta consulta
   * no lleva `empresa_id` porque no le hace falta y porque ponerlo a mano sería
   * confiar en que nadie lo olvide.
   */
  private async facturas(
    ctx: CtxEmpresa,
    rango: Rango,
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
          WHERE v.fecha BETWEEN $1::date AND $2::date
            AND v.tipo <> 'COTIZACION'
          ORDER BY v.fecha, v.consecutivo`,
        [rango.desde, rango.hasta],
      );
      return filas<FacturaLeida>(crudas);
    });
  }

  /**
   * Los dos gráficos, con los colores del reglamento.
   *
   * **Cómo se referencian depende de adónde va la hoja.** Al PDF viajan como
   * archivos del mismo `multipart` y el HTML los pide por nombre. A la pantalla
   * no pueden: la hoja se muestra dentro de un `iframe` y un nombre de archivo
   * suelto no apunta a nada, así que van empotrados como `data:`. Son dos
   * imágenes de unas decenas de KB y no tienen otro uso: no vale la pena una
   * ruta y un caché para ellas.
   */
  private async dibujar(
    hoja: VentasPorCliente,
    destino: Destino,
  ): Promise<Assets & { nombres: Record<string, string> }> {
    const assets: Assets = {};
    const nombres: Record<string, string> = {};
    const poner = (clave: string, archivo: string, png: Buffer): void => {
      if (destino === 'PDF') {
        assets[archivo] = png;
        nombres[clave] = archivo;
      } else {
        nombres[clave] = `data:image/png;base64,${png.toString('base64')}`;
      }
    };

    // Barras por día. El día de más ventas va en naranja: es lo único que el
    // acento señala en esta gráfica, y es lo que alguien busca al mirarla.
    const dia = await this.graficos.aPng(
      {
        type: 'bar',
        data: {
          // Un rótulo por semana. Treinta números al pie de una gráfica de
          // 430 px se pisan y no se lee ninguno; con uno cada siete, la escala
          // se entiende igual.
          labels: hoja.porDia.map((d, i) =>
            hoja.escala === 'MES' || i % 7 === 0 ? d.rotulo : '',
          ),
          datasets: [
            {
              // En millones, y el eje lo dice. QuickChart 1.8.1 solo
              // formatea los rótulos con una función JavaScript en el cuerpo,
              // que obliga a mandar la configuración sin comillas; dividir acá
              // da el mismo resultado sin salirse de JSON.
              data: hoja.porDia.map((d) => d.valor / 100_000_000),
              backgroundColor: hoja.porDia.map((d) =>
                hoja.pico !== null && d.clave === hoja.pico.clave
                  ? TINTA.atencion
                  : TINTA.resuelto,
              ),
              borderWidth: 0,
              barPercentage: 0.75,
            },
          ],
        },
        options: {
          scales: {
            xAxes: [
              {
                gridLines: { display: false, drawBorder: false },
                // Sin rotar: con un rótulo cada siete días caben derechos, y
                // un número en diagonal al pie de una gráfica impresa no se lee.
                ticks: {
                  fontColor: TINTA.apagado,
                  fontSize: 9,
                  autoSkip: false,
                  maxRotation: 0,
                  minRotation: 0,
                },
              },
            ],
            yAxes: [
              {
                gridLines: { color: '#ededed', drawBorder: false },
                ticks: {
                  fontColor: TINTA.apagado,
                  fontSize: 9,
                  maxTicksLimit: 4,
                  beginAtZero: true,
                },
              },
            ],
          },
        },
      },
      430,
      140,
    );
    if (dia !== null) poner('porDia', 'ventas-por-dia.png', dia);

    const estado = await this.graficos.aPng(
      {
        type: 'doughnut',
        data: {
          labels: ['Cobrado', 'Por cobrar', 'Vencido'],
          datasets: [
            {
              // Tres tramos, los mismos que las barras por cliente: cobrado,
              // lo que falta pero está al día, y lo vencido. Separar los dos
              // últimos es lo que hace que la dona diga algo más que «falta
              // plata».
              data: [
                hoja.resumen.tramos.cobrado,
                hoja.resumen.tramos.porCobrarAlDia,
                hoja.resumen.tramos.vencido,
              ],
              backgroundColor: [
                TINTA.resuelto,
                TINTA.tramos[2],
                TINTA.atencion,
              ],
              borderWidth: 0,
            },
          ],
        },
        options: { cutoutPercentage: 74 },
      },
      150,
      150,
    );
    if (estado !== null) poner('estado', 'estado-de-cobro.png', estado);

    return Object.assign(assets, { nombres });
  }

  /** La hoja entera, lista para imprimir o para mirar. */
  async armarHoja(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: { nombre: string; rol: string },
    destino: Destino = 'PDF',
    baseFuentes?: string,
  ): Promise<{
    html: string;
    assets: Assets;
    datos: VentasPorCliente;
    graficasFallidas: number;
  }> {
    const [datos, empresa] = await Promise.all([
      this.facturas(ctx, rango).then((fs) => armar(fs, rango)),
      this.membretes.de(ctx),
    ]);
    const { nombres, ...graficos } = await this.dibujar(datos, destino);

    const cuerpo = this.plantillas.cuerpo('ventas-por-cliente', {
      ...datos,
      graficos: nombres,
      diasParaVencer: DIAS_PARA_VENCER,
      porMes: datos.escala === 'MES',
      elaboro: quien.nombre,
      rol: quien.rol,
    });

    return {
      ...this.plantillas.armar({
        titulo: 'Ventas del mes por cliente',
        parametros: [
          `${rango.desde} a ${rango.hasta} · ${rango.etiqueta}`,
          'Ventas · facturas · agrupado por cliente',
        ],
        empresa,
        elaboro: quien.nombre,
        cuerpo,
        assets: graficos,
        destino,
        baseFuentes,
      }),
      datos,
      // Las que se pidieron y no llegaron. La hoja sale igual —las cifras y el
      // detalle son lo que se firma— pero la pantalla lo avisa.
      graficasFallidas: 2 - Object.keys(nombres).length,
    };
  }

  /** El PDF. */
  async pdf(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: { nombre: string; rol: string },
  ): Promise<Buffer> {
    const { html, assets } = await this.armarHoja(ctx, rango, quien);
    return this.gotenberg.aPdf(html, assets);
  }

  /**
   * El Excel: una fila por factura, sin agrupar —agrupar lo hace quien lo
   * abre—, y el resumen por cliente. Mismas facturas y mismas reglas que la
   * hoja. Sin gráficas y sin Gotenberg.
   */
  async xlsx(ctx: CtxEmpresa, rango: Rango): Promise<Buffer> {
    const [facturas, empresa] = await Promise.all([
      this.facturas(ctx, rango),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(libroVentas(facturas, rango), empresa);
  }
}
