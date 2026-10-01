import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El IVA de aseo, vigilancia, temporales y cooperativas se liquida sobre el
 * AIU (art. 462-1 ET, bug #16): la línea de compra guarda esa base.
 *
 * El DDL vive en `db/migrations/0102_compra_linea_iva_aiu.sql`.
 */
export class CompraLineaIvaAiu1787000102000 implements MigrationInterface {
  name = 'CompraLineaIvaAiu1787000102000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0102_compra_linea_iva_aiu'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE compra_documento_linea
         DROP CONSTRAINT ck_compra_linea_iva,
         ADD CONSTRAINT ck_compra_linea_iva
           CHECK (iva_valor = round(subtotal * iva_tarifa / 100, 2)),
         DROP CONSTRAINT ck_compra_linea_iva_base,
         DROP COLUMN iva_base;`,
    );
  }
}
