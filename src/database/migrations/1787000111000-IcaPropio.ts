import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * ICA propio: si la empresa tiene avisos y tableros en cada municipio.
 *
 * El DDL vive en `db/migrations/0111_ica_propio.sql`.
 */
export class IcaPropio1787000111000 implements MigrationInterface {
  name = 'IcaPropio1787000111000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0111_ica_propio'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE empresa_ica_propio;');
  }
}
