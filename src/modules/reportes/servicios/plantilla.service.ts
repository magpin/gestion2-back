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
  [
    'mono-400.woff2',
    '@fontsource/jetbrains-mono',
    'jetbrains-mono-latin-400-normal.woff2',
  ],
  [
    'mono-500.woff2',
    '@fontsource/jetbrains-mono',
    'jetbrains-mono-latin-500-normal.woff2',
  ],
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
  /**
   * Si se dibuja el bloque de firmas. Lo decide el reporte —ventas sí, cartera
   * no— y **no el destino**: la vista previa en pantalla muestra exactamente lo
   * que se va a imprimir, firmas incluidas, o dejaría de ser una vista previa.
   */
  conFirmas?: boolean;
  /**
   * Adónde va la hoja.
   *
   * **Cambia cómo se referencian las fuentes**, y nada más. Al PDF viajan como
   * archivos del mismo `multipart` y el CSS las pide por nombre; a la pantalla
   * las pide el navegador por una ruta de la API, que además las cachea entre
   * reportes en vez de mandarlas en cada uno.
   */
  destino?: Destino;
  /**
   * De dónde bajan las fuentes cuando la hoja va a pantalla: la dirección
   * **absoluta** de la API.
   *
   * Tiene que ser absoluta porque la hoja se muestra en un `iframe` con
   * `srcdoc`, y ahí una ruta relativa se resuelve contra la página que la
   * contiene —el frontend, en otro puerto—, no contra la API. Con
   * `/api/v1/reportes/fuentes` a secas, el navegador las pedía al 3000 y la
   * hoja caía a la fuente del sistema.
   */
  baseFuentes?: string;
}

export type Destino = 'PDF' | 'PANTALLA';

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
  private readonly cuerpos = new Map<string, HandlebarsTemplateDelegate>();
  private carpeta = '';

  onModuleInit(): void {
    const carpeta = join(__dirname, '..', 'plantillas');
    this.carpeta = carpeta;
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
    this.log.log(
      `Plantillas listas · ${Object.keys(this.fuentes).length} fuentes`,
    );
  }

  /**
   * El `@font-face` de las cinco caras, apuntando a donde corresponda.
   *
   * Es el único pedazo de CSS que depende del destino, y por eso se arma acá en
   * vez de vivir en `reporte.css`: reescribir un archivo de estilos con un
   * reemplazo de texto se rompe el día que alguien cambie una comilla.
   */
  private fuentesCss(destino: Destino, base: string): string {
    const donde = (archivo: string): string =>
      destino === 'PDF' ? archivo : `${base}/${archivo}`;

    return FUENTES.map(([archivo]) => {
      const [familia, peso] = archivo.startsWith('inter')
        ? ['Inter', archivo.slice(6, 9)]
        : ['JetBrains Mono', archivo.slice(5, 8)];
      return `@font-face{font-family:'${familia}';font-weight:${peso};font-display:block;src:url('${donde(archivo)}') format('woff2')}`;
    }).join('\n');
  }

  /** Las cinco caras, para servirlas por HTTP cuando la hoja va a pantalla. */
  fuente(nombre: string): Buffer | undefined {
    return this.fuentes[nombre];
  }

  /**
   * El cuerpo de un reporte, compilado una vez y guardado.
   *
   * Se compila al pedirlo y no al arrancar para que agregar un reporte sea
   * agregar un `.hbs` y nada más: sin una lista que mantener en dos lados, que
   * es donde se olvida el segundo.
   */
  cuerpo(nombre: string, datos: unknown): string {
    let plantilla = this.cuerpos.get(nombre);
    if (plantilla === undefined) {
      plantilla = Handlebars.compile(
        readFileSync(join(this.carpeta, `${nombre}.hbs`), 'utf8'),
      );
      this.cuerpos.set(nombre, plantilla);
    }
    return plantilla(datos);
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

    const destino = hoja.destino ?? 'PDF';
    const html = this.hoja({
      ...hoja,
      fuentes: new Handlebars.SafeString(
        this.fuentesCss(
          destino,
          hoja.baseFuentes ?? '/api/v1/reportes/fuentes',
        ),
      ),
      titulo: hoja.titulo,
      parametros: hoja.parametros,
      cuerpo: new Handlebars.SafeString(hoja.cuerpo),
      css: new Handlebars.SafeString(this.css),
      tamanoHoja: tamano,
      margenHoja: margen,
      claseHoja: orientacion === 'HORIZONTAL' ? 'horizontal' : 'vertical',
      conFirmas: hoja.conFirmas ?? true,
    });

    const footer = this.pie({
      margenLateral: MARGEN_LATERAL,
      pie: { izquierda: `Generado el ${this.ahora()}` },
    });

    return {
      html,
      assets: {
        // A pantalla no viajan: las pide el navegador por su ruta y las cachea
        // entre reportes, en vez de mandar 150 KB en cada uno.
        ...(destino === 'PDF' ? this.fuentes : {}),
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
