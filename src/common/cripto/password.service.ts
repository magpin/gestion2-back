import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Hash de contraseñas con argon2id.
 *
 * La verificación ocurre acá y nunca en SQL: comparar en la base metería la
 * contraseña en el log de consultas y expondría el tiempo de comparación.
 */
@Injectable()
export class PasswordService {
  async hashear(password: string): Promise<string> {
    return hash(password, { algorithm: 2 /* argon2id */ });
  }

  /**
   * Devuelve false ante un hash corrupto en vez de reventar: un registro dañado
   * no debe convertir un login fallido en un error 500.
   */
  async verificar(hashGuardado: string, password: string): Promise<boolean> {
    try {
      return await verify(hashGuardado, password);
    } catch {
      return false;
    }
  }
}
