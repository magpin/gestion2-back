import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Qué aportó cada documento al acumulado de ICA del período (plan motor de
 * retenciones, Fase 8, §8.4).
 *
 * El DDL vive en `db/migrations/0090_ica_aporte.sql`.
 */
export class IcaAporte1787000090000 implements MigrationInterface {
  name = 'IcaAporte1787000090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0090_ica_aporte'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE ica_acumulado_aporte;`);
  }
}
