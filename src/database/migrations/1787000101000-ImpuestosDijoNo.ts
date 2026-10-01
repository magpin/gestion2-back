import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Paso «Impuestos»: el «No» que contestó la persona queda guardado, para que
 * se vea marcado antes de «Todo correcto».
 *
 * El DDL vive en `db/migrations/0101_impuestos_dijo_no.sql`.
 */
export class ImpuestosDijoNo1787000101000 implements MigrationInterface {
  name = 'ImpuestosDijoNo1787000101000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0101_impuestos_dijo_no'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE empresa DROP COLUMN impuestos_dijo_no;',
    );
  }
}
