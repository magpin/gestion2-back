import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lo que una persona contestó sobre un renglón de factura, para no volver a
 * preguntarlo.
 *
 * El DDL vive en `db/migrations/0063_renglon_aprendido.sql`.
 */
export class RenglonAprendido1787000063000 implements MigrationInterface {
  name = 'RenglonAprendido1787000063000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0063_renglon_aprendido'));
  }

  /** Bajarla olvida lo aprendido: las facturas vuelven a preguntar. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS renglon_aprendido;`);
  }
}
