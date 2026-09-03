import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

import { ENTORNO, type Entorno } from '../../config/env';
import { AMBITO_PLATAFORMA, type Ctx, type RolCodigo } from '../ctx';

/**
 * Lo que viaja dentro del token. Nombres cortos a propósito: el token va en cada
 * petición.
 */
export interface Payload {
  /** usuario */
  sub: string;
  /** tenant */
  ten: string;
  /** empresa elegida, ausente mientras no se haya elegido */
  emp?: string;
  /** roles en esa empresa */
  rol: RolCodigo[];
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENTORNO) private readonly env: Entorno,
  ) {}

  /**
   * Token de sesión sin empresa. Lleva los roles de ámbito tenant —los que se
   * ejercen sobre la cuenta, no dentro de una contabilidad—, que es lo que
   * permite crear la primera empresa cuando todavía no hay ninguna.
   */
  firmarSesion(
    usuarioId: string,
    tenantId: string,
    roles: RolCodigo[] = [],
  ): string {
    return this.jwt.sign(
      { sub: usuarioId, ten: tenantId, rol: roles } satisfies Payload,
      this.opciones(),
    );
  }

  /** Token de trabajo: ya tiene empresa y roles. */
  firmarEmpresa(ctx: Ctx & { empresaId: string }): string {
    return this.jwt.sign(
      {
        sub: ctx.usuarioId,
        ten: ctx.tenantId,
        emp: ctx.empresaId,
        rol: ctx.roles,
      } satisfies Payload,
      this.opciones(),
    );
  }

  /**
   * Token de administración del producto.
   *
   * Lleva `amb` y NO lleva `ten` ni `emp`: `PlataformaGuard` exige lo primero, y
   * sin lo segundo no hay forma de armar un `Ctx` de negocio con él. Que un
   * administrador no pueda entrar a una contabilidad no depende de un `if`, sino
   * de que el token no tiene los campos para intentarlo.
   */
  firmarPlataforma(adminId: string, email: string, nombre: string): string {
    return this.jwt.sign(
      { sub: adminId, email, nombre, amb: AMBITO_PLATAFORMA },
      this.opciones(),
    );
  }

  /**
   * `expiresIn` viaja como texto ("8h") y la firma de jsonwebtoken lo tipa con
   * una plantilla que TypeScript no puede verificar desde una variable de
   * entorno. El casteo es acá y en un solo lugar.
   */
  private opciones(): JwtSignOptions {
    return {
      secret: this.env.jwt.secreto,
      expiresIn: this.env.jwt.expiraEn,
    } as JwtSignOptions;
  }

  /** Verifica la firma y arma el `Ctx`. No toca la base. */
  verificar(token: string): Ctx {
    const payload = this.jwt.verify<Payload>(token, {
      secret: this.env.jwt.secreto,
    });
    return {
      usuarioId: payload.sub,
      tenantId: payload.ten,
      empresaId: payload.emp,
      roles: payload.rol ?? [],
    };
  }
}
