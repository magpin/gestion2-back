import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENTORNO, type Entorno } from '../../config/env';

const ALGORITMO = 'aes-256-gcm';
const VERSION = 'v1';
const BYTES_IV = 12;

/**
 * Cifra y descifra el contenido de las columnas `_enc`.
 *
 * AES-256-GCM: además de cifrar, autentica. Si alguien altera el texto cifrado
 * en la base, el descifrado falla en vez de devolver basura silenciosamente.
 *
 * El formato guardado es `v1:iv:tag:cifrado`, todo en base64. La versión al
 * frente permite rotar el algoritmo más adelante sin adivinar qué es cada fila.
 *
 * La clave sale de `CLAVE_CIFRADO` y nunca de la base: si estuviera en la base,
 * quien se lleve un volcado se lleva también los certificados de la DIAN.
 */
@Injectable()
export class CifradoService {
  constructor(@Inject(ENTORNO) private readonly env: Entorno) {}

  cifrar(texto: string): string {
    const iv = randomBytes(BYTES_IV);
    const cipher = createCipheriv(ALGORITMO, this.env.claveCifrado, iv);
    const cifrado = Buffer.concat([
      cipher.update(texto, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      cifrado.toString('base64'),
    ].join(':');
  }

  descifrar(guardado: string): string {
    const partes = guardado.split(':');
    if (partes.length !== 4 || partes[0] !== VERSION) {
      throw new Error('Formato de dato cifrado desconocido');
    }
    const [, ivB64, tagB64, cifradoB64] = partes;
    const decipher = createDecipheriv(
      ALGORITMO,
      this.env.claveCifrado,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(cifradoB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Cifra solo si vino algo. Evita repetir el `undefined` en cada llamada. */
  cifrarOpcional(texto: string | undefined | null): string | null {
    return texto === undefined || texto === null || texto === ''
      ? null
      : this.cifrar(texto);
  }
}
