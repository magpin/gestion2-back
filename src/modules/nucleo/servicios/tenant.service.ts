import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { PasswordService } from '../../../common/cripto/password.service';
import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { ENTORNO, type Entorno } from '../../../config/env';
import type { CrearTenantDto } from '../dto/tenant.dto';

export interface TenantCreado {
  tenantId: string;
  usuarioId: string;
  email: string;
}

/**
 * Alta de cuentas nuevas.
 *
 * Es el único punto del sistema que se salta RLS, y no tiene alternativa: crear
 * un tenant ocurre antes de que exista tenant en sesión, así que las políticas
 * taparían la fila que se está insertando.
 *
 * Tres cosas lo acotan:
 *  - usa una conexión aparte (`gestion_provision`), nunca la de la API;
 *  - exige una clave de instalación por cabecera, que no es un token de usuario;
 *  - lo único que puede hacer es crear el tenant y su primer administrador.
 */
@Injectable()
export class TenantService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
    @Inject(ENTORNO) private readonly env: Entorno,
    private readonly passwords: PasswordService,
  ) {}

  async crear(dto: CrearTenantDto): Promise<TenantCreado> {
    if (this.provision === null) {
      throw new ServiceUnavailableException(
        'Falta configurar DB_PROVISION_USERNAME y DB_PROVISION_PASSWORD (rol gestion_provision).',
      );
    }

    const hash = await this.passwords.hashear(dto.password);

    return this.provision.transaction(async (t) => {
      const [tenant] = await t.query<Array<{ id: string }>>(
        `INSERT INTO tenant (nombre, slug, plan, max_empresas, max_usuarios)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          dto.nombre,
          dto.slug,
          dto.plan ?? 'BASICO',
          dto.maxEmpresas ?? 1,
          dto.maxUsuarios ?? 3,
        ],
      );

      const [usuario] = await t.query<Array<{ id: string; email: string }>>(
        `INSERT INTO usuario (tenant_id, email, nombre_completo, hash_password)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [tenant.id, dto.email, dto.nombreAdministrador, hash],
      );

      // Queda como ADMIN_TENANT: es el permiso de ambito cuenta, y es lo que le
      // permitira crear mas empresas e invitar usuarios.
      await t.query(
        `INSERT INTO usuario_rol_tenant (usuario_id, rol_codigo, tenant_id)
         VALUES ($1, 'ADMIN_TENANT', $2)`,
        [usuario.id, tenant.id],
      );

      return {
        tenantId: tenant.id,
        usuarioId: usuario.id,
        email: usuario.email,
      };
    });
  }
}
