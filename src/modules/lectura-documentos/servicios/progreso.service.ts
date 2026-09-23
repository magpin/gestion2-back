import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, finalize } from 'rxjs';

import type {
  DatoExtraido,
  TipoDocumento,
} from '../proveedores/extractor.puerto';

/**
 * El progreso de las lecturas de una empresa, y el botón de «Detener».
 *
 * Los eventos salen de hechos —se encoló, empezó, llegaron datos, terminó, falló—
 * y no de un temporizador. El §7.5 de la guía lo pide explícitamente y es fácil
 * hacer trampa: si no hay nada que informar, no se informa nada.
 *
 * **Vive en memoria, y por eso el estado no vive acá.** Esto es un canal, no un
 * registro: lo que hay que poder recuperar después de un F5 —en qué estado quedó
 * cada documento— está en la tabla `documento_leido`. Con más de una instancia
 * del servidor, un navegador colgado de la instancia B no vería el progreso de
 * una lectura que corre en la A; hoy hay una sola, y cuando haya dos esto se
 * resuelve con la tabla o con un canal de Postgres, no agrandando este archivo.
 */

export interface EventoProgreso {
  etapa: 'EN_COLA' | 'LEYENDO' | 'EXTRAYENDO' | 'LISTO' | 'ERROR';
  documento: TipoDocumento;
  documentoId: string;
  /** Lo que muestra el rótulo. Sale del hecho que lo generó. */
  mensaje: string;
  /** Los datos que llegaron con este evento. Vacío cuando no trae datos. */
  datos: DatoExtraido[];
}

/**
 * El avance de un lote (0067): cuántos van de cuántos y cuál se está leyendo.
 * Es el `{ hechos, total, etapa }` que pedía el plan de María (§ 9.4): con
 * esto la cara dibuja el arco y el encabezado dice «3 de 12».
 */
export interface EventoLote {
  etapa: 'LOTE';
  loteId: string;
  total: number;
  hechos: number;
  actual: string | null;
  terminado: boolean;
}

export type EventoDelFlujo = EventoProgreso | EventoLote;

@Injectable()
export class ProgresoService {
  private readonly log = new Logger(ProgresoService.name);
  private readonly canales = new Map<string, Subject<EventoDelFlujo>>();
  private readonly cortes = new Map<string, AbortController>();

  /** El flujo de una empresa. Se cierra cuando el último que mira se va. */
  flujo(empresaId: string): Observable<EventoDelFlujo> {
    const canal = this.canales.get(empresaId) ?? new Subject<EventoDelFlujo>();
    this.canales.set(empresaId, canal);

    return canal.asObservable().pipe(
      finalize(() => {
        if (!canal.observed) {
          this.canales.delete(empresaId);
        }
      }),
    );
  }

  emitir(empresaId: string, evento: EventoProgreso): void {
    this.canales.get(empresaId)?.next(evento);
  }

  /**
   * Deja registrado con qué cortar una lectura en curso. Es lo que convierte
   * «Detener» en algo que de verdad corta la llamada, en vez de tirar el
   * resultado cuando llega.
   */
  registrarCorte(documentoId: string): AbortController {
    const corte = new AbortController();
    this.cortes.set(documentoId, corte);
    return corte;
  }

  emitirLote(empresaId: string, evento: Omit<EventoLote, 'etapa'>): void {
    this.canales.get(empresaId)?.next({ etapa: 'LOTE', ...evento });
  }

  soltarCorte(documentoId: string): void {
    this.cortes.delete(documentoId);
  }

  /** `true` si había algo que cortar. */
  detener(documentoId: string): boolean {
    const corte = this.cortes.get(documentoId);
    if (corte === undefined) return false;

    this.log.log(`Lectura ${documentoId} detenida por una persona.`);
    corte.abort();
    this.cortes.delete(documentoId);
    return true;
  }
}
