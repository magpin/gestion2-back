import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Propuestas de cambio del perfil tributario desde la factura (plan motor de
 * retenciones, Fase 8, §8.8).
 *
 * El DDL vive en `db/migrations/0094_perfil_propuesta.sql`.
 */
export class PerfilPropuesta1787000094000 implements MigrationInterface {
  name = 'PerfilPropuesta1787000094000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0094_perfil_propuesta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE tercero_perfil_propuesta;`);
  }
}
