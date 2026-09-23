import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Una compra recuerda de qué documento leído salió.
 *
 * El DDL vive en `db/migrations/0062_compra_documento_leido.sql`.
 */
export class CompraDocumentoLeido1787000062000 implements MigrationInterface {
  name = 'CompraDocumentoLeido1787000062000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0062_compra_documento_leido'));
  }

  /**
   * Bajarla **pierde de qué documento salió cada compra**, y eso no se
   * reconstruye: la trazabilidad es el dato. Se deja porque una migración que
   * no baja bloquea el entorno de quien la está probando, no porque perderla
   * sea barato.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS ix_compra_documento_leido;
      ALTER TABLE compra_documento DROP COLUMN IF EXISTS documento_leido_id;
    `);
  }
}
