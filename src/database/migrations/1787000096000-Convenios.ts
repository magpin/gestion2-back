import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Tarifa de convenio (CDI) en pagos al exterior y la residencia fiscal del
 * proveedor (plan motor de retenciones, Fase 8, §8.15).
 *
 * El DDL vive en `db/migrations/0096_convenios.sql`.
 */
export class Convenios1787000096000 implements MigrationInterface {
  name = 'Convenios1787000096000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0096_convenios'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE tercero_residencia_fiscal;
      DROP TABLE cdi_tarifa;
    `);
  }
}
