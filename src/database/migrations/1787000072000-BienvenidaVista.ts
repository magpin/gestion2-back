import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La bienvenida de María al terminar la configuración: cuándo se vio.
 *
 * El DDL vive en `db/migrations/0072_bienvenida_vista.sql`.
 */
export class BienvenidaVista1787000072000 implements MigrationInterface {
  name = 'BienvenidaVista1787000072000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0072_bienvenida_vista'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE empresa DROP COLUMN bienvenida_vista_en',
    );
  }
}
