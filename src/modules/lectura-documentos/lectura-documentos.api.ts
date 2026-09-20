import { Injectable } from '@nestjs/common';

import { ExtractorService } from './servicios/extractor.service';

/**
 * Lo único que `lectura-documentos` expone a otros módulos.
 *
 * Es deliberadamente chico. El módulo no tiene nada que ofrecerle al resto del
 * sistema: lee documentos y propone hechos, y lo que se hace con esos hechos ya
 * lo decide `nucleo`. Lo único que a alguien más le puede importar es si el modo
 * está disponible —`estado-configuracion` podría querer contarlo algún día—.
 *
 * Que la fachada exista igual no es ceremonia: es lo que evita que el primer
 * módulo que necesite algo de acá se lleve un servicio interno.
 */
@Injectable()
export class LecturaDocumentosApi {
  constructor(private readonly extractor: ExtractorService) {}

  /** `false` si falta la clave del modelo o el bucket. */
  get disponible(): boolean {
    return this.extractor.disponible;
  }
}
