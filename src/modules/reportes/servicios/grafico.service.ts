import { Injectable, Logger } from '@nestjs/common';

/**
 * Los colores con los que se dibuja, del reglamento de `identidad-visual/`.
 *
 * **Los neutros construyen, el acento señala.** En una gráfica eso se traduce
 * en una regla muy concreta: lo resuelto va en negro, los tramos intermedios en
 * grises, y el naranja **solo lo que exige atención** —lo vencido, lo que pasó
 * de 90 días, el pico del mes—. Un gráfico con tres colores de marca no dice
 * dónde mirar.
 *
 * El otro motivo es el papel: así el gráfico **se sigue leyendo fotocopiado en
 * blanco y negro**, que es lo que el LEEME del diseño pide y lo que le pasa a
 * un reporte contable a la semana de impreso.
 */
export const TINTA = {
  /** Lo resuelto: cobrado, sin vencer, al día. */
  resuelto: '#171717',
  /** Los tramos intermedios, de más oscuro a más claro. */
  tramos: ['#4d4d4d', '#8a8a8a', '#b8b8b8'],
  /** Lo único que lleva color: lo que exige atención. */
  atencion: '#f25623',
  /** Ejes, grillas y rótulos. */
  apagado: '#8a8a8a',
} as const;

/**
 * Convierte una configuración de Chart.js en un PNG, hablándole a QuickChart.
 *
 * **La sintaxis es la de Chart.js v2**, no la v3: `options.legend` y no
 * `options.plugins.legend`, `cutoutPercentage` y no `cutout`. El QuickChart que
 * se autohospeda es la 1.8.1, y con la sintaxis de v3 **las opciones se ignoran
 * sin avisar** — pedir que no muestre la leyenda en el dialecto equivocado
 * devuelve un gráfico con leyenda y ningún error.
 *
 * Se usa un PNG y no un SVG porque es determinista: no depende de que un
 * JavaScript termine de dibujar dentro de Chromium antes de que Gotenberg
 * imprima la página.
 */
@Injectable()
export class GraficoService {
  private readonly log = new Logger(GraficoService.name);

  get disponible(): boolean {
    return (process.env.QUICKCHART_URL ?? '') !== '';
  }

  private get base(): string {
    return process.env.QUICKCHART_URL ?? 'http://localhost:3400';
  }

  /**
   * Lo que QuickChart hace si no se le dice lo contrario, y que en estos
   * reportes nunca se quiere.
   *
   * **La leyenda** sobra: el diseño pone los rótulos donde tienen que ir, con
   * su cifra al lado, y una leyenda arriba obliga a ir y volver con la vista
   * para saber qué es cada color.
   *
   * **Los `datalabels` vienen encendidos** —QuickChart trae el plugin cargado—
   * y escriben el valor crudo encima de cada tajada: «22.4» flotando sobre una
   * dona de pesos. Se apagan acá y no en cada llamada, porque es de esas cosas
   * que se olvidan una vez y salen impresas.
   */
  private conDefectos(config: Record<string, unknown>): Record<string, unknown> {
    const opciones = (config.options ?? {}) as Record<string, unknown>;
    const plugins = (opciones.plugins ?? {}) as Record<string, unknown>;
    return {
      ...config,
      options: {
        legend: { display: false },
        ...opciones,
        plugins: { datalabels: { display: false }, ...plugins },
      },
    };
  }

  /**
   * El PNG de una configuración. `ancho` y `alto` son los del **diseño**:
   * QuickChart dibuja al doble, así que un gráfico pedido a 300 vuelve de 600
   * píxeles y en el papel no se ve pixelado.
   *
   * Devuelve `null` si no se pudo. **Un reporte sin un gráfico sigue siendo un
   * reporte**: las cifras y el detalle son los que se firman. Tumbar la hoja
   * entera porque no se dibujó una dona sería cambiar algo importante por algo
   * que lo acompaña.
   */
  async aPng(
    config: Record<string, unknown>,
    ancho: number,
    alto: number,
  ): Promise<Buffer | null> {
    const parametros = new URLSearchParams({
      c: JSON.stringify(this.conDefectos(config)),
      w: String(ancho),
      h: String(alto),
      backgroundColor: 'transparent',
      f: 'png',
    });

    try {
      const respuesta = await fetch(`${this.base}/chart?${parametros.toString()}`);
      if (!respuesta.ok) {
        this.log.warn(`QuickChart rechazó la configuración (${respuesta.status}).`);
        return null;
      }
      const png = Buffer.from(await respuesta.arrayBuffer());

      // Igual que con el PDF: un 200 no garantiza una imagen. Los bytes 1 a 3
      // de un PNG son las letras `PNG`.
      if (png.subarray(1, 4).toString() !== 'PNG') {
        this.log.warn(`QuickChart devolvió ${png.length} bytes que no son un PNG.`);
        return null;
      }
      return png;
    } catch (error: unknown) {
      const motivo = error instanceof Error ? error.message : String(error);
      this.log.warn(`QuickChart no contesta en ${this.base}: ${motivo}`);
      return null;
    }
  }
}
