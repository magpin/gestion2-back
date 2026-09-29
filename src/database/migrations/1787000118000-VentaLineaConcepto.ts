import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Líneas de venta por concepto: servicios y otros ingresos sin producto.
 *
 * El DDL vive en `db/migrations/0118_venta_linea_concepto.sql`.
 */
export class VentaLineaConcepto1787000118000 implements MigrationInterface {
  name = 'VentaLineaConcepto1787000118000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0118_venta_linea_concepto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS ix_venta_linea_concepto;
       DROP INDEX IF EXISTS ix_linea_producto;
       CREATE INDEX ix_linea_producto ON venta_documento_linea (producto_id);
       ALTER TABLE venta_documento_linea
         DROP CONSTRAINT ck_venta_linea_producto_o_concepto,
         DROP CONSTRAINT fk_venta_linea_cuenta,
         DROP CONSTRAINT fk_venta_linea_concepto,
         DROP COLUMN detalle, DROP COLUMN cuenta_id, DROP COLUMN concepto_id,
         ALTER COLUMN producto_id SET NOT NULL;`,
    );
  }
}
