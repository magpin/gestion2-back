import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Lo que se acepta subir. Un `.exe` con nombre de foto no entra.
 *
 * El PDF entró con el modo IA del asistente: un RUT o un certificado de Cámara
 * de Comercio llega en PDF, y el navegador los sube por el mismo camino firmado
 * que las fotos del catálogo.
 */
const TIPOS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
]);

/** Cuánto vive una URL firmada. */
const MINUTOS_SUBIDA = 5;
const MINUTOS_LECTURA = 60;

/**
 * El único punto por donde el proyecto habla con el bucket.
 *
 * **El archivo no pasa por la API**: se firma una URL temporal y el navegador
 * sube directo a MinIO. Una foto de tres megas multiplicada por quien esté
 * cargando el catálogo ocuparía el servidor para nada, y el bucket sabe
 * recibir archivos mejor que nosotros.
 *
 * Firmar es HMAC local: no hay viaje de red, así que firmar cincuenta URLs
 * para una página de catálogo cuesta microsegundos.
 *
 * Adentro de la red de contenedores el bucket se llama `minio`; el navegador
 * tiene que alcanzarlo por `localhost` (o por el dominio público). Son dos
 * direcciones del mismo bucket y por eso hay dos clientes: uno para hablarle y
 * otro solo para firmar lo que el navegador va a abrir.
 */
@Injectable()
export class AlmacenamientoApi {
  private readonly log = new Logger(AlmacenamientoApi.name);
  private readonly bucket = process.env.S3_BUCKET ?? 'gestion';
  private readonly interno: S3Client;
  private readonly publico: S3Client;

  constructor() {
    const config = {
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
      // MinIO no resuelve `bucket.host`: la llave va en la ruta.
      forcePathStyle: true,
    };
    this.interno = new S3Client({
      ...config,
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    });
    this.publico = new S3Client({
      ...config,
      endpoint:
        process.env.S3_ENDPOINT_PUBLICO ??
        process.env.S3_ENDPOINT ??
        'http://localhost:9000',
    });
  }

  /** `true` si hay bucket configurado. Sin esto, subir imágenes se apaga solo. */
  get disponible(): boolean {
    return (
      (process.env.S3_ACCESS_KEY ?? '') !== '' &&
      (process.env.S3_SECRET_KEY ?? '') !== ''
    );
  }

  /**
   * La URL a la que el navegador le hace `PUT` con el archivo, y la llave con
   * la que después se confirma. La llave la decide el servidor: si la eligiera
   * el cliente podría pisar la imagen de otro producto.
   */
  async firmarSubida(
    prefijo: string,
    tipoMime: string,
    /** Tipo MIME → extensión. Por defecto, fotos y PDF; el asistente acepta más. */
    tipos: ReadonlyMap<string, string> = TIPOS,
  ): Promise<{ url: string; clave: string }> {
    const extension = tipos.get(tipoMime);
    if (extension === undefined) {
      throw new BadRequestException(
        tipos === TIPOS
          ? `Ese archivo no se puede subir (${tipoMime}). Se aceptan JPG, PNG, WebP y PDF.`
          : `Ese archivo no se puede subir (${tipoMime}).`,
      );
    }

    const clave = `${prefijo}/${randomUUID()}.${extension}`;
    const url = await getSignedUrl(
      this.publico,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clave,
        ContentType: tipoMime,
      }),
      { expiresIn: MINUTOS_SUBIDA * 60 },
    );
    return { url, clave };
  }

  /**
   * Baja el objeto al servidor.
   *
   * Es la excepción a «el archivo no pasa por la API», y tiene un solo uso: el
   * modo IA del asistente necesita el contenido para mandárselo al modelo. Lo
   * baja para leerlo, con la llave que guardó la fila, y —si se subió sin decir
   * qué es— una vez antes para reconocerlo, con una llave que viene del
   * navegador pero que ya se comprobó que es del prefijo de la empresa
   * (`exigirClaveDeLaEmpresa`).
   */
  async descargar(clave: string): Promise<{
    contenido: Buffer;
    tipoMime: string;
  }> {
    const objeto = await this.interno.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: clave }),
    );

    if (objeto.Body === undefined) {
      throw new BadRequestException(`El archivo ${clave} ya no está.`);
    }

    return {
      contenido: Buffer.from(await objeto.Body.transformToByteArray()),
      // Lo que el bucket registró al recibirlo. La extensión de la llave no
      // decide: la puso el servidor, pero el contenido lo puso el navegador.
      tipoMime: objeto.ContentType ?? 'application/octet-stream',
    };
  }

  /** La URL con la que el navegador ve el archivo. Caduca: no es un enlace público. */
  async firmarLectura(clave: string): Promise<string> {
    return getSignedUrl(
      this.publico,
      new GetObjectCommand({ Bucket: this.bucket, Key: clave }),
      { expiresIn: MINUTOS_LECTURA * 60 },
    );
  }

  /**
   * Borra el objeto. No falla si no está: reemplazar una imagen no puede
   * romperse porque la anterior ya no exista —el dato que importa es la
   * columna, y esa ya se actualizó—.
   */
  async borrar(clave: string): Promise<void> {
    try {
      await this.interno.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: clave }),
      );
    } catch (error) {
      this.log.warn(
        `No se pudo borrar ${clave} del bucket: ${String(error)}. La fila ya no lo referencia.`,
      );
    }
  }
}
