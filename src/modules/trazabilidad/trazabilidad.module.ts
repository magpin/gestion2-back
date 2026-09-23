import { Module } from '@nestjs/common';

import { LecturaDocumentosModule } from '../lectura-documentos/lectura-documentos.module';
import { TrazabilidadController } from './controladores/trazabilidad.controller';
import { TrazabilidadService } from './servicios/trazabilidad.service';

/**
 * `trazabilidad` — de dónde salió un asiento: el documento, lo que María leyó
 * y comprobó, quién lo aprobó y cuándo. Tanda 2 de `docs/planes/maria.md` §11.
 *
 * **Solo lee.** El historial no se edita: si algo estuvo mal, se anula y queda
 * a la vista, como el resto del libro.
 */
@Module({
  imports: [LecturaDocumentosModule],
  controllers: [TrazabilidadController],
  providers: [TrazabilidadService],
})
export class TrazabilidadModule {}
