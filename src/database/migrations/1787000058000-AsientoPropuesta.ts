import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * De qué propuesta de María salió un asiento, para que la pantalla pueda
 * decirlo sin suponerlo.
 *
 * El DDL vive en `db/migrations/0058_asiento_propuesta.sql`.
 */
export class AsientoPropuesta1787000058000 implements MigrationInterface {
  name = 'AsientoPropuesta1787000058000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0058_asiento_propuesta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Se pierde de dónde vino cada asiento; los asientos se quedan.
    await queryRunner.query(`
      DROP INDEX IF EXISTS ix_asiento_propuesta;
      ALTER TABLE asiento
        DROP CONSTRAINT IF EXISTS fk_asiento_propuesta,
        DROP COLUMN IF EXISTS propuesta_id;
    `);
  }
}
