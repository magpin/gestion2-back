import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { AlmacenamientoApi } from '../almacenamiento/almacenamiento.api';
import { DocumentoService } from './servicios/documento.service';
import { ExtractorService } from './servicios/extractor.service';

/** El archivo detrás de un asiento, como lo muestra su historial. */
export interface DocumentoSoporte {
  /** sha256 en hexadecimal. `null` si el archivo ya no está en el bucket. */
  huella: string | null;
  /** URL firmada para abrirlo. Caduca; `null` si no se pudo firmar. */
  url: string | null;
}

/**
 * Lo único que `lectura-documentos` expone a otros módulos.
 *
 * Es deliberadamente chico. El módulo no tiene nada que ofrecerle al resto del
 * sistema: lee documentos y propone hechos, y lo que se hace con esos hechos ya
 * lo decide `nucleo`. Lo único que a alguien más le puede importar es si el modo
 * está disponible —`estado-configuracion` podría querer contarlo algún día— y,
 * desde la trazabilidad del asiento, el archivo que se leyó.
 *
 * Que la fachada exista igual no es ceremonia: es lo que evita que el primer
 * módulo que necesite algo de acá se lleve un servicio interno.
 */
@Injectable()
export class LecturaDocumentosApi {
  private readonly log = new Logger(LecturaDocumentosApi.name);

  constructor(
    private readonly extractor: ExtractorService,
    private readonly documentos: DocumentoService,
    private readonly almacenamiento: AlmacenamientoApi,
  ) {}

  /** `false` si falta la clave del modelo o el bucket. */
  get disponible(): boolean {
    return this.extractor.disponible;
  }

  /**
   * La huella y el enlace del archivo leído. Los documentos leídos antes de la
   * 0066 no tienen huella: se calcula acá la primera vez y queda guardada.
   *
   * Un bucket caído no rompe el historial: el asiento y sus pasos se muestran
   * igual, y el documento sale sin enlace.
   */
  async soporte(
    ctx: CtxEmpresa,
    documento: { id: string; clave: string; huella: string | null },
  ): Promise<DocumentoSoporte> {
    let huella = documento.huella;
    if (huella === null) {
      try {
        const archivo = await this.almacenamiento.descargar(documento.clave);
        huella = await this.documentos.guardarHuella(
          ctx,
          documento.id,
          archivo.contenido,
        );
      } catch (e) {
        this.log.warn(
          `Sin huella para ${documento.id}: ${(e as Error).message}`,
        );
      }
    }
    let url: string | null = null;
    try {
      url = await this.almacenamiento.firmarLectura(documento.clave);
    } catch (e) {
      this.log.warn(`Sin enlace para ${documento.id}: ${(e as Error).message}`);
    }
    return { huella, url };
  }
}
