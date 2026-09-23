import { Module } from '@nestjs/common';

import { RevisionController } from './controladores/revision.controller';
import { RevisionApi } from './revision.api';
import { RevisionService } from './servicios/revision.service';

/**
 * `revision` — los errores que se afirman: descuadres, duplicados y fechas
 * que no pueden ser ciertas a la vez. Fase 7 de
 * `docs/planes/maria-facturas-y-errores.md`.
 *
 * **Solo lee.** Encuentra; corregir es de una persona, por las pantallas de
 * siempre. Lee directo las tablas de otros módulos, como `reportes`, porque
 * cada comprobación cruza dos de ellos.
 */
@Module({
  controllers: [RevisionController],
  providers: [RevisionService, RevisionApi],
  exports: [RevisionApi],
})
export class RevisionModule {}
