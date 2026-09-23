import { Controller, Get } from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { RevisionService } from '../servicios/revision.service';

/**
 * Lo que no cuadra y lo que está dos veces.
 *
 * Los roles son los que ven los asientos (`GET /asientos`): lo que se muestra
 * acá sale de los libros, y quien no los ve no tiene por qué ver sus
 * diferencias.
 */
@Controller('revision')
@ExigeEmpresa()
export class RevisionController {
  constructor(private readonly revision: RevisionService) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  revisar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.revision.revisar(ctx);
  }
}
