import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Retenciones: la ley cargada con vigencias (plan motor de retenciones, Fase 0).
 *
 * El DDL vive en `db/migrations/0074_retenciones_ley.sql`.
 */
export class RetencionesLey1787000074000 implements MigrationInterface {
  name = 'RetencionesLey1787000074000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0074_retenciones_ley'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE retencion_zomac_factor;
      DROP TABLE retencion_tarifa;
      DROP TABLE retencion_concepto_nacional;
      DROP TABLE retencion_migracion_registro;
      ALTER TABLE uvt DROP COLUMN norma, DROP COLUMN validado_por, DROP COLUMN validado_en;
    `);
  }
}
