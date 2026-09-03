import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Clientes y proveedores de cada empresa, con sus responsabilidades fiscales DIAN.
 *
 * El DDL vive en `db/migrations/0008_tercero.sql`.
 */
export class Tercero1787000008000 implements MigrationInterface {
  name = 'Tercero1787000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0008_tercero'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tercero_responsabilidad_fiscal;
DROP TABLE IF EXISTS tercero;`);
  }
}
