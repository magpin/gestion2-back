import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/** Lo que va junto al HTML: fuentes, gráficos, el logo. Nombre → contenido. */
export type Assets = Record<string, Buffer>;

/**
 * Convierte HTML en PDF hablándole a Gotenberg.
 *
 * Gotenberg es un contenedor aparte con Chromium adentro. **No es una librería
 * y es a propósito:** la imagen de la API es `node:24-alpine`, y meterle
 * Chromium obligaría a cambiarla a Debian-slim y a pedirle más memoria a cada
 * instancia. Así el PDF escala por su lado y, si se cae, se cae el PDF y no la
 * API. Es la misma decisión que tomó SINE, y por las mismas razones.
 */
@Injectable()
export class GotenbergService {
  private readonly log = new Logger(GotenbergService.name);

  /** Sin la dirección no se ofrece: el mismo criterio que el bucket y la clave. */
  get disponible(): boolean {
    return (process.env.GOTENBERG_URL ?? '') !== '';
  }

  private get base(): string {
    return process.env.GOTENBERG_URL ?? 'http://localhost:3010';
  }

  /**
   * El HTML y sus archivos en un solo `multipart`. Gotenberg los escribe juntos
   * en una carpeta temporal y abre `index.html`, así que el HTML los referencia
   * por nombre de archivo, sin ruta.
   *
   * **Los assets van adentro, nunca por URL.** Desde el contenedor de Gotenberg
   * `localhost` es Gotenberg, no esta máquina: un `<img src="http://localhost…">`
   * no carga y **el PDF sale igual**, más liviano y sin la imagen, sin un solo
   * error. Es la misma trampa de las dos direcciones que `S3_ENDPOINT` y
   * `S3_ENDPOINT_PUBLICO` resuelven para MinIO. Embeberlos, además, hace que
   * Gotenberg no necesite red: una cosa menos que puede fallar a mitad de un
   * reporte.
   *
   * **El tamaño de hoja no se manda acá.** Va en la regla `@page` del CSS de
   * cada plantilla, porque el CSS le gana a `paperWidth` y `paperHeight` —y
   * cuando le gana, los ignora en silencio—. Tenerlo en un solo lado es además
   * lo que hace que la vista previa en pantalla imprima igual que el PDF.
   */
  async aPdf(html: string, assets: Assets = {}): Promise<Buffer> {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    for (const [nombre, contenido] of Object.entries(assets)) {
      form.append('files', new Blob([new Uint8Array(contenido)]), nombre);
    }

    const empezo = Date.now();
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.base}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
      });
    } catch (error: unknown) {
      // El contenedor no está. Es distinto de un HTML mal armado y el mensaje
      // tiene que decirlo, porque lo que hay que hacer es distinto.
      const motivo = error instanceof Error ? error.message : String(error);
      this.log.error(`Gotenberg no contesta en ${this.base}: ${motivo}`);
      throw new ServiceUnavailableException(
        'El servicio que arma los PDF no está disponible. El reporte se puede ver en pantalla.',
      );
    }

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      this.log.error(
        `Gotenberg rechazó el HTML (${respuesta.status}): ${detalle.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException('No se pudo armar el PDF.');
    }

    const pdf = Buffer.from(await respuesta.arrayBuffer());

    // Un PDF vacío también llega con 200. Que empiece por `%PDF-` es lo único
    // que distingue un archivo de un cuerpo vacío, y el que lo abra después no
    // va a tener forma de saber qué pasó.
    if (pdf.subarray(0, 5).toString() !== '%PDF-') {
      this.log.error(
        `Gotenberg devolvió ${pdf.length} bytes que no son un PDF.`,
      );
      throw new ServiceUnavailableException('No se pudo armar el PDF.');
    }

    this.log.log(
      `PDF armado en ${Date.now() - empezo} ms · ${Math.round(pdf.length / 1024)} KB · ` +
        `${Object.keys(assets).length} archivos`,
    );
    return pdf;
  }
}
