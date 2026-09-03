import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PasswordService } from '../../../common/cripto/password.service';
import type { Ctx, RolCodigo } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  AsignarRolDto,
  CrearUsuarioDto,
  EditarUsuarioDto,
} from '../dto/usuario.dto';

@Injectable()
export class UsuarioService {
  constructor(
    private readonly tx: TxService,
    private readonly passwords: PasswordService,
  ) {}

  async crear(
    ctx: Ctx,
    dto: CrearUsuarioDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.verificarCupo(t, ctx);

      const hash = await this.passwords.hashear(dto.password);
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO usuario (tenant_id, email, nombre_completo, hash_password)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, nombre_completo, activo, creado_en`,
        [ctx.tenantId, dto.email, dto.nombreCompleto, hash],
      );

      // Los accesos se asignan en la misma transaccion: un usuario sin ninguna
      // empresa asignada no puede entrar a nada, y quedaria colgado esperando una
      // segunda llamada que puede no llegar.
      for (const acceso of dto.accesos ?? []) {
        await this.asignarRolEn(t, ctx, fila.id as string, acceso);
      }

      if (dto.esAdminTenant === true) {
        await this.asignarAdminTenantEn(t, ctx, fila.id as string);
      }

      return fila;
    });
  }

  async listar(ctx: Ctx): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT u.id, u.email, u.nombre_completo, u.activo, u.ultimo_acceso_en, u.creado_en,
                (SELECT count(*) > 0 FROM usuario_rol_tenant urt
                  WHERE urt.usuario_id = u.id AND urt.rol_codigo = 'ADMIN_TENANT'
                    AND urt.revocado_en IS NULL) AS es_admin_tenant,
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object('empresaId', uer.empresa_id, 'empresa', e.razon_social, 'rol', uer.rol_codigo)
                    ORDER BY e.razon_social, uer.rol_codigo
                  ) FILTER (WHERE uer.usuario_id IS NOT NULL),
                  '[]'::jsonb
                ) AS accesos
           FROM usuario u
           LEFT JOIN usuario_empresa_rol uer ON uer.usuario_id = u.id AND uer.revocado_en IS NULL
           LEFT JOIN empresa e ON e.id = uer.empresa_id
          GROUP BY u.id
          ORDER BY u.nombre_completo`,
      ),
    );
  }

  async editar(
    ctx: Ctx,
    id: string,
    dto: EditarUsuarioDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const hash =
        dto.password === undefined
          ? null
          : await this.passwords.hashear(dto.password);
      const editado = fila<Record<string, unknown>>(
        await t.query(
          `UPDATE usuario
            SET nombre_completo = COALESCE($2, nombre_completo),
                hash_password   = COALESCE($3, hash_password)
          WHERE id = $1
          RETURNING id, email, nombre_completo, activo`,
          [id, dto.nombreCompleto ?? null, hash],
        ),
      );
      if (editado === undefined) {
        throw new NotFoundException('Usuario no encontrado');
      }
      return editado;
    });
  }

  /**
   * Un usuario se desactiva, nunca se borra: sus acciones quedan firmadas en
   * documentos y en asignaciones de permisos, y borrarlo dejaría huérfano todo
   * ese rastro.
   */
  async desactivar(ctx: Ctx, id: string): Promise<void> {
    if (id === ctx.usuarioId) {
      throw new BadRequestException('No puedes desactivarte a ti mismo');
    }
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE usuario SET activo = false WHERE id = $1', [id]),
    );
  }

  async reactivar(ctx: Ctx, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await this.verificarCupo(t, ctx);
      await t.query('UPDATE usuario SET activo = true WHERE id = $1', [id]);
    });
  }

  async asignarRol(
    ctx: Ctx,
    usuarioId: string,
    dto: AsignarRolDto,
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      this.asignarRolEn(t, ctx, usuarioId, dto),
    );
  }

  /**
   * Revocar deja la fila con `revocado_en`. Queda el rastro de quién tuvo acceso
   * y hasta cuándo, que es justo lo que pide una auditoría.
   */
  async revocarRol(
    ctx: Ctx,
    usuarioId: string,
    empresaId: string,
    rol: RolCodigo,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const revocados = filas<{ usuario_id: string }>(
        await t.query(
          `UPDATE usuario_empresa_rol SET revocado_en = now()
            WHERE usuario_id = $1 AND empresa_id = $2 AND rol_codigo = $3 AND revocado_en IS NULL
            RETURNING usuario_id`,
          [usuarioId, empresaId, rol],
        ),
      );
      if (revocados.length === 0) {
        throw new NotFoundException(
          'Ese acceso no existe o ya estaba revocado',
        );
      }
    });
  }

  /**
   * `ADMIN_TENANT` es de ámbito cuenta y vive en otra tabla: no se ejerce dentro
   * de una contabilidad, sino sobre la suscripción entera. El trigger de la base
   * rechaza meterlo en `usuario_empresa_rol`.
   */
  async asignarAdminTenant(ctx: Ctx, usuarioId: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      this.asignarAdminTenantEn(t, ctx, usuarioId),
    );
  }

  async revocarAdminTenant(ctx: Ctx, usuarioId: string): Promise<void> {
    if (usuarioId === ctx.usuarioId) {
      throw new BadRequestException(
        'No puedes quitarte a ti mismo la administracion de la cuenta',
      );
    }
    await this.tx.enContexto(ctx, async (t) => {
      // Dejar la cuenta sin ningun administrador la vuelve inmanejable: nadie
      // podria volver a crear empresas ni invitar usuarios.
      const [conteo] = await t.query<Array<{ vivos: string }>>(
        `SELECT count(*) AS vivos FROM usuario_rol_tenant urt
           JOIN usuario u ON u.id = urt.usuario_id
          WHERE urt.rol_codigo = 'ADMIN_TENANT' AND urt.revocado_en IS NULL AND u.activo`,
      );
      if (Number(conteo.vivos) <= 1) {
        throw new BadRequestException('La cuenta quedaria sin administrador');
      }
      await t.query(
        `UPDATE usuario_rol_tenant SET revocado_en = now()
          WHERE usuario_id = $1 AND rol_codigo = 'ADMIN_TENANT' AND revocado_en IS NULL`,
        [usuarioId],
      );
    });
  }

  private async asignarAdminTenantEn(
    t: Tx,
    ctx: Ctx,
    usuarioId: string,
  ): Promise<void> {
    await t.query(
      `INSERT INTO usuario_rol_tenant (usuario_id, rol_codigo, tenant_id, asignado_por_id)
       VALUES ($1, 'ADMIN_TENANT', $2, $3)
       ON CONFLICT (usuario_id, rol_codigo)
       DO UPDATE SET revocado_en = NULL, asignado_en = now(), asignado_por_id = $3`,
      [usuarioId, ctx.tenantId, ctx.usuarioId],
    );
  }

  private async asignarRolEn(
    t: Tx,
    ctx: Ctx,
    usuarioId: string,
    dto: AsignarRolDto,
  ): Promise<void> {
    // Reasignar un rol revocado reabre la fila en vez de crear otra: la clave
    // primaria es (usuario, empresa, rol) y un mismo permiso no se duplica.
    await t.query(
      `INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, rol_codigo, tenant_id, asignado_por_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id, empresa_id, rol_codigo)
       DO UPDATE SET revocado_en = NULL, asignado_en = now(), asignado_por_id = $5`,
      [usuarioId, dto.empresaId, dto.rol, ctx.tenantId, ctx.usuarioId],
    );
  }

  private async verificarCupo(t: Tx, ctx: Ctx): Promise<void> {
    const [cupo] = await t.query<
      Array<{ max_usuarios: number; usados: string }>
    >(
      `SELECT t.max_usuarios,
              (SELECT count(*) FROM usuario u WHERE u.tenant_id = t.id AND u.activo) AS usados
         FROM tenant t WHERE t.id = $1`,
      [ctx.tenantId],
    );
    if (cupo !== undefined && Number(cupo.usados) >= cupo.max_usuarios) {
      throw new ForbiddenException(
        `El plan permite ${cupo.max_usuarios} usuario(s) activo(s). Ampliar el plan para agregar mas.`,
      );
    }
  }
}
