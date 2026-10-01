import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La retención que el proveedor imprimió en la factura (plan motor de
 * retenciones, Fase 8, §8.6).
 *
 * El DDL vive en `db/migrations/0091_compra_retencion_impresa.sql`.
 */
export class CompraRetencionImpresa1787000091000 implements MigrationInterface {
  name = 'CompraRetencionImpresa1787000091000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0091_compra_retencion_impresa'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE compra_documento DROP COLUMN retencion_impresa;`,
    );
  }
}
