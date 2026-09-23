import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import type { Hallazgo } from './reglas/revision.reglas';
import { RevisionService } from './servicios/revision.service';

export type { Hallazgo } from './reglas/revision.reglas';

/**
 * Lo que `revision` ofrece a otros módulos: correr las comprobaciones.
 *
 * Como toda fachada, **no mira roles**: quien llama lo hace. Hoy la usa
 * `conversacion`, para que María pueda contestar «¿hay algo mal?».
 */
@Injectable()
export class RevisionApi {
  constructor(private readonly revision: RevisionService) {}

  revisar(ctx: CtxEmpresa): Promise<Hallazgo[]> {
    return this.revision.revisar(ctx);
  }
}
