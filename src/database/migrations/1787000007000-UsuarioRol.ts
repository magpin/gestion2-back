import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Usuarios, catalogo de roles y el acceso por empresa. Las FK compuestas
 * impiden asignarle a un usuario una empresa de otro tenant.
 *
 * El DDL vive en `db/migrations/0007_usuario_rol.sql`.
 */
export class UsuarioRol1787000007000 implements MigrationInterface {
  name = 'UsuarioRol1787000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0007_usuario_rol'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_usuario_para_login(citext);
DROP TABLE IF EXISTS usuario_empresa_rol;
DROP TABLE IF EXISTS rol;
DROP TABLE IF EXISTS usuario;`);
  }
}
