import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La cuenta que paga la suscripcion. Un tenant tiene N empresas: un contador
 * con quince clientes es un solo tenant.
 *
 * El DDL vive en `db/migrations/0002_tenant.sql`.
 */
export class Tenant1787000002000 implements MigrationInterface {
  name = 'Tenant1787000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0002_tenant'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tenant;`);
  }
}
