import { Injectable, UnauthorizedException } from '@nestjs/common';

import { TokenService } from '../../../common/auth/token.service';
import { PasswordService } from '../../../common/cripto/password.service';
import type { Ctx, CtxPlataforma, RolCodigo } from '../../../common/ctx';
import { TxService, type Tx } from '../../../common/db/tx.service';

export interface EmpresaAccesible {
  id: string;
  razonSocial: string;
  nit: string;
  dv: string;
  roles: RolCodigo[];
}

export interface ResultadoLogin {
  ambito: 'CLIENTE';
  token: string;
  usuario: { id: string; nombre: string; email: string };
  /**
   * Roles de ambito cuenta. Viajan en la respuesta y no solo dentro del token
   * porque el cliente los necesita antes de elegir empresa: son los que deciden
   * si a alguien sin ninguna empresa se le ofrece crear la primera.
   */
  roles: RolCodigo[];
  empresas: EmpresaAccesible[];
}

/** Lo que devuelve el mismo `/auth/login` cuando quien entra administra el producto. */
export interface ResultadoLoginPlataforma {
  ambito: 'PLATAFORMA';
  token: string;
  admin: CtxPlataforma;
}

interface FilaLogin {
  id: string;
  tenant_id: string;
  hash_password: string;
  activo: boolean;
  tenant_estado: string;
}

interface FilaAdmin {
  id: string;
  email: string;
  nombre_completo: string;
  hash_password: string;
  activo: boolean;
}

/**
 * Hash de descarte. Verificar contra él cuando el correo no existe hace que la
 * respuesta tarde lo mismo que una contraseña equivocada, y así el tiempo no
 * delata qué correos están registrados.
 */
const HASH_DESCARTE =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$0000000000000000000000000000000';

@Injectable()
export class AutenticacionService {
  constructor(
    private readonly tx: TxService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Verifica credenciales y devuelve un token de sesión, sin empresa todavía.
   *
   * Es la única puerta de entrada del sistema: por acá entran los clientes y
   * también quien administra el producto. Los dos almacenes de credenciales
   * siguen separados (`usuario` y `plataforma_admin`); lo que se unificó es el
   * endpoint, no las tablas.
   *
   * El correo decide la rama y **no hay caída de una a otra**: si el correo está
   * en `plataforma_admin`, la contraseña se verifica ahí y ahí termina. Probar
   * después contra `usuario` dejaría que un cliente registrado con el correo de
   * un administrador tantee las dos.
   *
   * Todas las salidas de error dicen lo mismo —"correo o contrasena incorrectos"—
   * a propósito: distinguir "ese correo no existe" de "esa clave esta mal" le
   * regala a un atacante la lista de correos registrados.
   */
  async login(
    email: string,
    password: string,
  ): Promise<ResultadoLogin | ResultadoLoginPlataforma> {
    const admin = await this.buscarAdmin(email);
    if (admin !== undefined) {
      return this.entrarComoAdmin(admin, password);
    }
    return this.entrarComoCliente(email, password);
  }

  private async entrarComoCliente(
    email: string,
    password: string,
  ): Promise<ResultadoLogin> {
    const generico = new UnauthorizedException(
      'Correo o contrasena incorrectos',
    );

    // `fn_usuario_para_login` es SECURITY DEFINER: es la unica lectura que
    // atraviesa RLS, porque al autenticar todavia no hay tenant en sesion.
    const filas = await this.tx.sinContexto((tx) =>
      tx.query<FilaLogin[]>('SELECT * FROM fn_usuario_para_login($1)', [email]),
    );
    const fila = filas[0];

    if (fila === undefined) {
      await this.passwords.verificar(HASH_DESCARTE, password);
      throw generico;
    }

    const coincide = await this.passwords.verificar(
      fila.hash_password,
      password,
    );
    if (!coincide || !fila.activo) {
      throw generico;
    }

    if (fila.tenant_estado === 'CANCELADO') {
      throw new UnauthorizedException('La cuenta esta cancelada');
    }

    const ctxParcial: Ctx = {
      usuarioId: fila.id,
      tenantId: fila.tenant_id,
      roles: [],
    };
    const rolesTenant = await this.rolesTenant(ctxParcial);
    const empresas = await this.empresasDe(ctxParcial);
    const datos = await this.datosUsuario(ctxParcial);

    await this.marcarAcceso(ctxParcial);

    return {
      ambito: 'CLIENTE',
      token: this.tokens.firmarSesion(fila.id, fila.tenant_id, rolesTenant),
      usuario: datos,
      roles: rolesTenant,
      empresas,
    };
  }

  // ---------------------------------------------------------------------------
  // Administración del producto
  // ---------------------------------------------------------------------------

  /**
   * `plataforma_admin` no lleva RLS y `gestion_app` ya tiene SELECT y UPDATE
   * sobre ella, así que se lee con la conexión de siempre. No hace falta la de
   * aprovisionamiento: autenticar no es administrar.
   */
  private async buscarAdmin(email: string): Promise<FilaAdmin | undefined> {
    const filas = await this.tx.sinContexto((tx) =>
      tx.query<FilaAdmin[]>(
        `SELECT id, email, nombre_completo, hash_password, activo
           FROM plataforma_admin WHERE email = $1`,
        [email],
      ),
    );
    return filas[0];
  }

  private async entrarComoAdmin(
    admin: FilaAdmin,
    password: string,
  ): Promise<ResultadoLoginPlataforma> {
    const generico = new UnauthorizedException(
      'Correo o contrasena incorrectos',
    );

    const coincide = await this.passwords.verificar(
      admin.hash_password,
      password,
    );
    if (!coincide) {
      // La consola de plataforma muestra los intentos fallidos de cada
      // administrador. Solo la fecha: ni la contraseña probada ni un pedazo.
      await this.tx.sinContexto((tx) =>
        tx.query('INSERT INTO login_fallido (admin_id) VALUES ($1)', [admin.id]),
      );
    }
    if (!coincide || !admin.activo) {
      throw generico;
    }

    await this.tx.sinContexto((tx) =>
      tx.query(
        'UPDATE plataforma_admin SET ultimo_acceso_en = now() WHERE id = $1',
        [admin.id],
      ),
    );

    return {
      ambito: 'PLATAFORMA',
      token: this.tokens.firmarPlataforma(
        admin.id,
        admin.email,
        admin.nombre_completo,
      ),
      admin: { adminId: admin.id, email: admin.email },
    };
  }

  /** Las empresas a las que el usuario tiene acceso, con los roles que ejerce en cada una. */
  async empresasDe(ctx: Ctx, tx?: Tx): Promise<EmpresaAccesible[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<
          Array<{
            id: string;
            razon_social: string;
            nit: string;
            dv: string;
            roles: RolCodigo[];
          }>
        >(
          `SELECT e.id, e.razon_social, e.nit, e.dv,
                  array_agg(uer.rol_codigo ORDER BY uer.rol_codigo) AS roles
             FROM usuario_empresa_rol uer
             JOIN empresa e ON e.id = uer.empresa_id
            WHERE uer.usuario_id = $1
              AND uer.revocado_en IS NULL
              AND e.activo
            GROUP BY e.id, e.razon_social, e.nit, e.dv
            ORDER BY e.razon_social`,
          [ctx.usuarioId],
        );
        return filas.map((f) => ({
          id: f.id,
          razonSocial: f.razon_social,
          nit: f.nit,
          dv: f.dv,
          roles: f.roles,
        }));
      },
      tx,
    );
  }

  /**
   * Emite el token de trabajo para una empresa concreta.
   *
   * Los roles salen de la base en este momento y quedan firmados en el token. Si
   * después se le revoca un permiso al usuario, el token viejo sigue valiendo
   * hasta que expire — es el costo conocido de no consultar la base en cada
   * petición, y por eso la expiración es corta.
   */
  async elegirEmpresa(
    ctx: Ctx,
    empresaId: string,
  ): Promise<{ token: string; roles: RolCodigo[] }> {
    const empresas = await this.empresasDe(ctx);
    const elegida = empresas.find((e) => e.id === empresaId);
    if (elegida === undefined) {
      throw new UnauthorizedException('Sin acceso a esa empresa');
    }
    // Los permisos se suman: los de la cuenta acompañan a los de la empresa. Un
    // ADMIN_TENANT sigue siéndolo mientras trabaja dentro de una contabilidad.
    const rolesTenant = await this.rolesTenant(ctx);
    const roles = [...new Set([...rolesTenant, ...elegida.roles])];
    const conEmpresa = { ...ctx, empresaId, roles };
    return { token: this.tokens.firmarEmpresa(conEmpresa), roles };
  }

  /**
   * Roles de ámbito cuenta. Existen fuera de toda empresa: son los que permiten
   * crear la primera, invitar gente y manejar la suscripción.
   */
  async rolesTenant(ctx: Ctx, tx?: Tx): Promise<RolCodigo[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<Array<{ rol_codigo: RolCodigo }>>(
          `SELECT rol_codigo FROM usuario_rol_tenant
            WHERE usuario_id = $1 AND revocado_en IS NULL`,
          [ctx.usuarioId],
        );
        return filas.map((f) => f.rol_codigo);
      },
      tx,
    );
  }

  /** Los roles vigentes en la base, no los del token. Lo usa la fachada. */
  async rolesDe(ctx: Ctx, empresaId: string, tx?: Tx): Promise<RolCodigo[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<Array<{ rol_codigo: RolCodigo }>>(
          `SELECT rol_codigo FROM usuario_empresa_rol
            WHERE usuario_id = $1 AND empresa_id = $2 AND revocado_en IS NULL`,
          [ctx.usuarioId, empresaId],
        );
        return filas.map((f) => f.rol_codigo);
      },
      tx,
    );
  }

  /**
   * Los roles vigentes de **otra** persona en una empresa, y su nombre. Una
   * persona desactivada no tiene roles. Lo usa el asistente: una regla de
   * autonomía actúa con los roles de quien la activó, mirados al actuar
   * (paso 8 de `asistente-conversacion.md`).
   */
  async rolesVigentesDe(
    ctx: Ctx,
    usuarioId: string,
    empresaId: string,
  ): Promise<{ nombre: string; roles: RolCodigo[] }> {
    return this.tx.enContexto(ctx, async (t) => {
      const filas = await t.query<
        Array<{
          nombre_completo: string;
          activo: boolean;
          rol_codigo: RolCodigo | null;
        }>
      >(
        `SELECT u.nombre_completo, u.activo, uer.rol_codigo
           FROM usuario u
           LEFT JOIN usuario_empresa_rol uer
             ON uer.usuario_id = u.id AND uer.empresa_id = $2 AND uer.revocado_en IS NULL
          WHERE u.id = $1`,
        [usuarioId, empresaId],
      );
      if (filas.length === 0) return { nombre: '', roles: [] };
      return {
        nombre: filas[0].nombre_completo,
        roles: filas[0].activo
          ? filas.flatMap((f) => (f.rol_codigo === null ? [] : [f.rol_codigo]))
          : [],
      };
    });
  }

  private async datosUsuario(
    ctx: Ctx,
  ): Promise<{ id: string; nombre: string; email: string }> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<
        Array<{ id: string; nombre_completo: string; email: string }>
      >('SELECT id, nombre_completo, email FROM usuario WHERE id = $1', [
        ctx.usuarioId,
      ]);
      return { id: fila.id, nombre: fila.nombre_completo, email: fila.email };
    });
  }

  /**
   * El último acceso, y una fila por día en `usuario_acceso_dia`: la consola de
   * plataforma cuenta cuántos entraron ayer o esta semana, y el último acceso
   * solo no alcanza para eso.
   */
  private async marcarAcceso(ctx: Ctx): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await t.query(
        'UPDATE usuario SET ultimo_acceso_en = now() WHERE id = $1',
        [ctx.usuarioId],
      );
      await t.query(
        `INSERT INTO usuario_acceso_dia (usuario_id, tenant_id, dia)
         VALUES ($1, $2, (now() AT TIME ZONE 'America/Bogota')::date)
         ON CONFLICT DO NOTHING`,
        [ctx.usuarioId, ctx.tenantId],
      );
    });
  }
}
