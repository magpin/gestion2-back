import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Compras — módulo 5 de la secuencia: `compra_documento`,
 * `compra_documento_linea` y `compra_retencion`. El modelo completo vive en
 * `docs/planes/compras-backend.md`.
 *
 * El DDL vive en `db/migrations/0031_compras.sql`.
 */
export class Compras1787000031000 implements MigrationInterface {
  name = 'Compras1787000031000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0031_compras'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS compra_retencion');
    await queryRunner.query('DROP TABLE IF EXISTS compra_documento_linea');
    await queryRunner.query('DROP TABLE IF EXISTS compra_documento');
  }
}
