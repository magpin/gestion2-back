import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Períodos automáticos: marca qué cierres hizo el sistema.
 *
 * El DDL vive en `db/migrations/0071_periodo_automatico.sql`.
 */
export class PeriodoAutomatico1787000071000 implements MigrationInterface {
  name = 'PeriodoAutomatico1787000071000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0071_periodo_automatico'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE periodo_contable DROP COLUMN cierre_automatico',
    );
  }
}
