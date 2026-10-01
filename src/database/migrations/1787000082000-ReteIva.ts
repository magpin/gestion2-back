import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * ReteIVA: el IVA que asume la empresa en servicios del exterior (plan motor
 * de retenciones, Fase 2).
 *
 * El DDL vive en `db/migrations/0082_reteiva.sql`.
 */
export class ReteIva1787000082000 implements MigrationInterface {
  name = 'ReteIva1787000082000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0082_reteiva'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE compra_retencion DROP COLUMN asumida');
  }
}
