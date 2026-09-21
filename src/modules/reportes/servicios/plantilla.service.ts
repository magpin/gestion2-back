import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Handlebars from 'handlebars';

import type { Assets } from './gotenberg.service';

/** Vertical para casi todo; horizontal para lo que tiene muchas columnas. */
export type Orientacion = 'VERTICAL' | 'HORIZONTAL';

/**
 * Carta, en pulgadas, y los márgenes del diseño —52 px arriba, 64 a los lados,
 * 44 abajo, a 96 puntos por pulgada—.
 *
 * Arriba y abajo se agrandan para dejarle sitio al pie, que Chromium imprime
 * **dentro** del margen: con el margen justo del diseño, el pie no se ve.
 */
const HOJA: Record<Orientacion, { tamano: string; margen: string }> = {
  VERTICAL: { tamano: '8.5in 11in', margen: '0.54in 0.67in 0.62in' },
  HORIZONTAL: { tamano: '11in 8.5in', margen: '0.54in 0.67in 0.62in' },
};

const MARGEN_LATERAL = '0.67in';

/** Las cinco caras que usan las plantillas, con el nombre con que van al CSS. */
const FUENTES: ReadonlyArray<[string, string, string]> = [
  ['inter-400.woff2', '@fontsource/inter', 'inter-latin-400-normal.woff2'],
  ['inter-600.woff2', '@fontsource/inter', 'inter-latin-600-normal.woff2'],
  ['inter-700.woff2', '@fontsource/inter', 'inter-latin-700-normal.woff2'],
  ['mono-400.woff2', '@fontsource/jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'],
  ['mono-500.woff2', '@fontsource/jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2'],
];

export interface Hoja {
  /** Lo que va arriba del todo. «Ventas del mes por cliente». */
  titulo: string;
  /** Con qué se corrió, en palabras. Se lee meses después, cuando nadie se acuerda. */
  parametros: string[];
  empresa: { razonSocial: string; nit: string; dv?: string; ciudad?: string };
  /** Quién apretó el botón. Va en «Elaboró». */
  elaboro?: string;
  orientacion?: Orientacion;
  /** El HTML del reporte. Ya viene armado por la plantilla de cada uno. */
  cuerpo: string;
  /** Los gráficos y lo demás que el cuerpo referencia por nombre de archivo. */
  assets?: Assets;
  /** Si se dibuja el bloque de firmas. Una vista previa en pantalla no lo lleva. */
  conFirmas?: boolean;
}

/**
 * Arma la hoja completa: membrete, título, parámetros, cuerpo, firmas y pie,
 * con su CSS y sus fuentes.
 *
 * **Las fuentes viajan como archivos en el `multipart`**, junto al HTML, y el
 * CSS las referencia por nombre. No se piden a Google Fonts: el contenedor de
 * Gotenberg puede no tener salida a internet, y entonces el PDF sale con otra
 * tipografía y **no falla** —sale feo, que es peor, porque nadie se entera—.
 * Salen de `@fontsource`, que es una dependencia con versión, y no de archivos
 * sueltos commiteados a mano.
 */
@Injectable()
export class PlantillaService implements OnModuleInit {
  private readonly log = new Logger(PlantillaService.name);
  private readonly requerir = createRequire(__filename);

  private css = '';
  private fuentes: Assets = {};
  private pie!: HandlebarsTemplateDelegate;
  private hoja!: HandlebarsTemplateDelegate;

  onModuleInit(): void {
    const carpeta = join(__dirname, '..', 'plantillas');
    const leer = (nombre: string): string =>
      readFileSync(join(carpeta, nombre), 'utf8');

    this.css = leer('reporte.css');
    Handlebars.registerPartial('membrete', leer('_membrete.hbs'));
    Handlebars.registerPartial('firmas', leer('_firmas.hbs'));
    this.pie = Handlebars.compile(leer('pie.hbs'));
    this.hoja = Handlebars.compile(leer('hoja.hbs'));

    for (const [destino, paquete, archivo] of FUENTES) {
      const ruta = join(
        this.requerir.resolve(`${paquete}/package.json`),
        '..',
        'files',
        archivo,
      );
      this.fuentes[destino] = readFileSync(ruta);
    }
    this.log.log(`Plantillas listas · ${Object.keys(this.fuentes).length} fuentes`);
  }

  /**
   * El `multipart` completo: `index.html`, `footer.html` y todos los archivos.
   *
   * El cuerpo llega **ya armado** por la plantilla de cada reporte y se inserta
   * sin escapar: es HTML nuestro, no texto de afuera. Lo que sí viene de la
   * base —razón social, nombres— pasa por Handlebars y se escapa solo.
   */
  armar(hoja: Hoja): { html: string; assets: Assets } {
    const orientacion = hoja.orientacion ?? 'VERTICAL';
    const { tamano, margen } = HOJA[orientacion];

    const html = this.hoja({
      ...hoja,
      titulo: hoja.titulo,
      parametros: hoja.parametros,
      cuerpo: new Handlebars.SafeString(hoja.cuerpo),
      css: new Handlebars.SafeString(this.css),
      tamanoHoja: tamano,
      margenHoja: margen,
      conFirmas: hoja.conFirmas ?? true,
    });

    const footer = this.pie({
      margenLateral: MARGEN_LATERAL,
      pie: { izquierda: `Generado el ${this.ahora()}` },
    });

    return {
      html,
      assets: {
        ...this.fuentes,
        ...(hoja.assets ?? {}),
        'footer.html': Buffer.from(footer, 'utf8'),
      },
    };
  }

  /**
   * La fecha de generación, en hora de Colombia y en el formato que se lee acá.
   * No es un adorno: dice desde cuándo los números de la hoja pueden estar
   * viejos.
   */
  private ahora(): string {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Bogota',
    }).format(new Date());
  }
}
