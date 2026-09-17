import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El corte diario de una cuenta bancaria.
 *
 * El DDL vive en `db/migrations/0046_banco_corte.sql`.
 */
export class BancoCorte1787000046000 implements MigrationInterface {
  name = 'BancoCorte1787000046000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0046_banco_corte'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS banco_corte');
  }
}
