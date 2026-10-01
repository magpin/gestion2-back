import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Configuración: el paso «Impuestos», con el ICA por municipio (plan motor de
 * retenciones, Fase 0, §0.7).
 *
 * El DDL vive en `db/migrations/0077_impuestos_paso.sql`.
 */
export class ImpuestosPaso1787000077000 implements MigrationInterface {
  name = 'ImpuestosPaso1787000077000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0077_impuestos_paso'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE empresa_ica_municipio;
      ALTER TABLE empresa DROP COLUMN impuestos_confirmado_en;
      DELETE FROM retencion_migracion_registro WHERE migracion = '0077';
    `);
  }
}
