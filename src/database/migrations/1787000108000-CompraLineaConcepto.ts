import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La línea de gasto de una compra lleva su concepto.
 *
 * El DDL vive en `db/migrations/0108_compra_linea_concepto.sql`.
 */
export class CompraLineaConcepto1787000108000 implements MigrationInterface {
  name = 'CompraLineaConcepto1787000108000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0108_compra_linea_concepto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX ix_compra_linea_concepto;
       ALTER TABLE compra_documento_linea DROP CONSTRAINT ck_compra_linea_concepto_sin_producto;
       ALTER TABLE compra_documento_linea DROP CONSTRAINT fk_compra_linea_concepto;
       ALTER TABLE compra_documento_linea DROP COLUMN concepto_id;`,
    );
  }
}
