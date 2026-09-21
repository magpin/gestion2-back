import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Las reglas de autonomía del asistente: por acción, con límite y dueño. Solo
 * se agregan.
 *
 * El DDL vive en `db/migrations/0053_asistente_regla.sql`.
 */
export class AsistenteRegla1787000053000 implements MigrationInterface {
  name = 'AsistenteRegla1787000053000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0053_asistente_regla'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // La clave foránea de la propuesta primero; después la tabla. Lo que se
    // pierde es el historial de reglas; lo registrado sigue en sus documentos.
    await queryRunner.query(`
      ALTER TABLE asistente_propuesta DROP CONSTRAINT IF EXISTS fk_asistente_propuesta_regla;
      DROP TABLE IF EXISTS asistente_regla;
    `);
  }
}
