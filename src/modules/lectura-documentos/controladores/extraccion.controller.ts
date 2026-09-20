import { Controller, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { ProgresoService } from '../servicios/progreso.service';

/**
 * El progreso de las lecturas, en vivo.
 *
 * Es el único endpoint del proyecto que no contesta y corta: queda abierto
 * mandando eventos. Cada uno sale de un hecho —se encoló, empezó, llegaron
 * datos, terminó, falló—, que es lo que el §7.5 de la guía exige y lo que un
 * temporizador en el frontend no puede dar.
 *
 * El token viaja en `Authorization`, como en todo lo demás. `EventSource` del
 * navegador no sabe mandar cabeceras, así que la pantalla lo consume con `fetch`
 * y lectura del cuerpo por partes; es una nota para el paso 7, no una licencia
 * para abrir este endpoint sin autenticar.
 */
@Controller('configuracion/ia')
@ExigeEmpresa()
export class ExtraccionController {
  constructor(private readonly progreso: ProgresoService) {}

  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Sse('progreso')
  flujo(@ActorEmpresa() ctx: CtxEmpresa): Observable<MessageEvent> {
    return this.progreso
      .flujo(ctx.empresaId)
      .pipe(map((evento) => ({ data: evento })));
  }
}
