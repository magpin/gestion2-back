import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los administradores del producto y el rastro de lo que hacen sobre las cuentas.
 *
 * Van en tabla propia y no en `usuario` porque no pertenecen a ningún tenant, y
 * porque separarlos acota el daño: un error en el login de clientes no alcanza
 * estas credenciales.
 *
 * El DDL vive en `db/migrations/0011_plataforma.sql`.
 */
export class Plataforma1787000011000 implements MigrationInterface {
  name = 'Plataforma1787000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0011_plataforma'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS plataforma_bitacora;
DROP TABLE IF EXISTS plataforma_admin;`);
  }
}
