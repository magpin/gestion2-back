import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Roles de ámbito TENANT (`ADMIN_TENANT`), que se ejercen sobre la cuenta y no
 * dentro de una contabilidad. Sin ellos, el primer usuario de una cuenta nueva no
 * podría crear su primera empresa: no hay empresa donde asignarle un rol.
 *
 * Agrega además los dos triggers que impiden mezclar ámbitos entre las dos tablas
 * de permisos.
 *
 * El DDL vive en `db/migrations/0009_usuario_rol_tenant.sql`.
 */
export class UsuarioRolTenant1787000009000 implements MigrationInterface {
  name = 'UsuarioRolTenant1787000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0009_usuario_rol_tenant'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS tg_validar_rol_empresa ON usuario_empresa_rol;
DROP TABLE IF EXISTS usuario_rol_tenant;
DROP FUNCTION IF EXISTS fn_validar_rol_tenant();
DROP FUNCTION IF EXISTS fn_validar_rol_empresa();`);
  }
}
