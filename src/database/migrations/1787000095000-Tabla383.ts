import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Honorarios y servicios de persona natural por la tabla del art. 383 (plan
 * motor de retenciones, Fase 8, §8.14, R-D16).
 *
 * El DDL vive en `db/migrations/0095_tabla_383.sql`.
 */
export class Tabla3831787000095000 implements MigrationInterface {
  name = 'Tabla3831787000095000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0095_tabla_383'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE retencion_parametro_ley;
      DROP TABLE retencion_tabla_383;
      ALTER TABLE retencion_concepto_nacional DROP COLUMN usa_tabla_383;
      ALTER TABLE tercero_perfil_tributario DROP COLUMN contrato_dos_o_mas_trabajadores;
    `);
  }
}
