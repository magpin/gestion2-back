import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La cuenta de ingreso por producto — la pareja que le faltaba a
 * `cuenta_costo_venta_id` (`0026`). `ventas-backend.md` ya describía el
 * asiento de una factura con "crédito cuenta_ingreso DEL PRODUCTO"; esta
 * columna es la que lo hace posible.
 *
 * El DDL vive en `db/migrations/0028_producto_cuenta_ingreso.sql`.
 */
export class ProductoCuentaIngreso1787000028000 implements MigrationInterface {
  name = 'ProductoCuentaIngreso1787000028000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0028_producto_cuenta_ingreso'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE producto DROP CONSTRAINT IF EXISTS fk_producto_cuenta_ingreso',
    );
    await queryRunner.query(
      'ALTER TABLE producto DROP COLUMN IF EXISTS cuenta_ingreso_id',
    );
  }
}
