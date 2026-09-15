import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Notas débito de venta, notas crédito y débito de compra, y la columna que
 * hace posible la nota parcial (`linea_origen_id`).
 *
 * El DDL vive en `db/migrations/0039_notas_debito.sql`.
 */
export class NotasDebito1787000039000 implements MigrationInterface {
  name = 'NotasDebito1787000039000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0039_notas_debito'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Compras
    await queryRunner.query('DROP INDEX ix_compra_origen');
    await queryRunner.query(
      'ALTER TABLE compra_documento DROP CONSTRAINT uq_compra_numero_proveedor',
    );
    await queryRunner.query(
      'ALTER TABLE compra_documento ADD CONSTRAINT uq_compra_numero_proveedor UNIQUE (empresa_id, tercero_id, numero_factura_proveedor)',
    );
    await queryRunner.query(
      'ALTER TABLE compra_documento DROP CONSTRAINT ck_compra_origen, DROP CONSTRAINT fk_compra_origen, DROP CONSTRAINT ck_compra_tipo',
    );
    await queryRunner.query(
      'ALTER TABLE compra_documento DROP COLUMN documento_origen_id, DROP COLUMN tipo',
    );

    // Las líneas
    await queryRunner.query('DROP INDEX ix_linea_compra_origen');
    await queryRunner.query('DROP INDEX ix_linea_venta_origen');
    await queryRunner.query(
      'ALTER TABLE compra_documento_linea DROP CONSTRAINT fk_linea_compra_origen, DROP COLUMN linea_origen_id, DROP CONSTRAINT uq_linea_compra_id_empresa',
    );
    await queryRunner.query(
      'ALTER TABLE venta_documento_linea DROP CONSTRAINT fk_linea_venta_origen, DROP COLUMN linea_origen_id, DROP CONSTRAINT uq_linea_venta_id_empresa',
    );

    // Ventas: si ya existe alguna NOTA_DEBITO, estos dos fallan — y es lo
    // correcto, el tipo ya está en los datos.
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_origen',
    );
    await queryRunner.query(`ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_origen CHECK (
      (tipo = 'NOTA_CREDITO' AND documento_origen_id IS NOT NULL)
      OR (tipo = 'FACTURA')
      OR (tipo = 'COTIZACION' AND documento_origen_id IS NULL)
    )`);
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_tipo',
    );
    await queryRunner.query(`ALTER TABLE venta_documento ADD CONSTRAINT venta_documento_tipo_check CHECK (
      tipo IN ('COTIZACION', 'FACTURA', 'NOTA_CREDITO')
    )`);
  }
}
