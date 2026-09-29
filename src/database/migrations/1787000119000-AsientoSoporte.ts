import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El soporte adjunto del comprobante manual.
 *
 * El DDL vive en `db/migrations/0119_asiento_soporte.sql`.
 */
export class AsientoSoporte1787000119000 implements MigrationInterface {
  name = 'AsientoSoporte1787000119000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0119_asiento_soporte'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE asiento_soporte;');
  }
}
