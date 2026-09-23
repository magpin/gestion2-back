import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lo confirmado de una lectura y el modo de configuración de la empresa.
 *
 * El DDL vive en `db/migrations/0068_confirmacion_y_modo.sql`.
 */
export class ConfirmacionYModo1787000068000 implements MigrationInterface {
  name = 'ConfirmacionYModo1787000068000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0068_confirmacion_y_modo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE empresa DROP COLUMN modo_configuracion;
      ALTER TABLE documento_leido DROP COLUMN confirmacion, DROP COLUMN confirmado_en;
    `);
  }
}
