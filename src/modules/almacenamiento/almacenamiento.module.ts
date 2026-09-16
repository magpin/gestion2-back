import { Global, Module } from '@nestjs/common';

import { AlmacenamientoApi } from './almacenamiento.api';

/**
 * Global porque es infraestructura, no un contexto de negocio: cualquier
 * módulo que algún día guarde un archivo —la imagen del producto hoy, el PDF
 * de un documento mañana— le habla a la misma fachada.
 */
@Global()
@Module({
  providers: [AlmacenamientoApi],
  exports: [AlmacenamientoApi],
})
export class AlmacenamientoModule {}
