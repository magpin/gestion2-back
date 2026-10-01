import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { ENTORNO, type Entorno } from '../../config/env';

/** Cuántas claves erradas se aguantan por IP en la ventana. */
const INTENTOS = 10;
const VENTANA_MS = 60_000;
/** Cuánto queda cerrada la puerta para esa IP después de pasarse. */
const CASTIGO_MS = 5 * 60_000;

/**
 * La puerta del tablero de consumo (`docs/planes/consumo-ia.md`): una clave en
 * la cabecera `x-clave-consumo`, contra `CLAVE_CONSUMO_IA`.
 *
 * Sobre el patrón de `ProvisionGuard`, con dos cosas más, porque esta puerta da
 * a cifras de todas las empresas:
 *
 * - **Se compara en tiempo constante.** Un `!==` tarda más cuanto más
 *   caracteres coinciden, y eso deja adivinar la clave de a uno. Se comparan
 *   las huellas SHA-256, que además tienen siempre el mismo largo.
 * - **Se frenan los intentos a ciegas**: 10 claves erradas en un minuto desde
 *   una IP la dejan afuera cinco minutos. Vive en memoria, como el límite del
 *   chat: alcanza con un solo servidor.
 *
 * Sin la variable configurada, la puerta no existe: 503.
 */
@Injectable()
export class ClaveConsumoGuard implements CanActivate {
  private readonly fallos = new Map<
    string,
    { veces: number; desde: number; cerradaHasta: number }
  >();

  constructor(@Inject(ENTORNO) private readonly env: Entorno) {}

  canActivate(contexto: ExecutionContext): boolean {
    if (this.env.claveConsumoIa === undefined) {
      throw new ServiceUnavailableException(
        'El tablero de consumo no está habilitado: falta CLAVE_CONSUMO_IA en el entorno.',
      );
    }

    const req = contexto.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'sin-ip';
    const ahora = Date.now();
    const registro = this.fallos.get(ip);
    if (registro !== undefined && registro.cerradaHasta > ahora) {
      throw new HttpException(
        'Demasiados intentos. Espere unos minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const clave = req.headers['x-clave-consumo'];
    if (typeof clave === 'string' && iguales(clave, this.env.claveConsumoIa)) {
      this.fallos.delete(ip);
      return true;
    }

    this.anotarFallo(ip, ahora);
    throw new UnauthorizedException('Clave incorrecta');
  }

  private anotarFallo(ip: string, ahora: number) {
    const r = this.fallos.get(ip);
    const vigente = r !== undefined && ahora - r.desde < VENTANA_MS;
    const veces = vigente ? r.veces + 1 : 1;
    this.fallos.set(ip, {
      veces,
      desde: vigente ? r.desde : ahora,
      cerradaHasta: veces >= INTENTOS ? ahora + CASTIGO_MS : 0,
    });
  }
}

/** Compara dos claves en tiempo constante, sea cual sea su largo. */
export function iguales(a: string, b: string): boolean {
  const huella = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(huella(a), huella(b));
}
