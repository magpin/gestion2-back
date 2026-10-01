import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El clasificador con IA (fuente 5) y los aciertos por fuente (plan motor de
 * retenciones, Fase 5).
 *
 * El DDL vive en `db/migrations/0085_clasificador_ia.sql`.
 */
export class ClasificadorIa1787000085000 implements MigrationInterface {
  name = 'ClasificadorIa1787000085000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0085_clasificador_ia'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE retencion_clasificacion_uso;
      DROP TABLE retencion_clasificacion_ia;
    `);
  }
}
