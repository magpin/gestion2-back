import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Primer ajuste que le pide `ventas` (módulo 4) a `inventario`, ya
 * construido: la cuenta de costo de venta por producto, y `'SALIDA_VENTA'`
 * en el `CHECK` de `producto_movimiento.tipo`. `'ENTRADA_COMPRA'` no se
 * agrega todavía — eso lo decide Compras cuando le toque.
 *
 * El DDL vive en `db/migrations/0026_producto_costo_venta.sql`.
 */
export class ProductoCostoVenta1787000026000 implements MigrationInterface {
  name = 'ProductoCostoVenta1787000026000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0026_producto_costo_venta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE producto_movimiento DROP CONSTRAINT IF EXISTS ck_movimiento_tipo',
    );
    await queryRunner.query(
      `ALTER TABLE producto_movimiento ADD CONSTRAINT producto_movimiento_tipo_check
         CHECK (tipo IN ('ENTRADA_INICIAL', 'ENTRADA_AJUSTE', 'SALIDA_AJUSTE'))`,
    );
    await queryRunner.query(
      'ALTER TABLE producto DROP CONSTRAINT IF EXISTS fk_producto_cuenta_costo_venta',
    );
    await queryRunner.query(
      'ALTER TABLE producto DROP COLUMN IF EXISTS cuenta_costo_venta_id',
    );
  }
}
