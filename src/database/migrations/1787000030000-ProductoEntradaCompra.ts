import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Suma `'ENTRADA_COMPRA'` al `CHECK` de `producto_movimiento.tipo` — el tipo
 * que `KardexService.registrarEntradaCompra` va a insertar (paso 2 de
 * `docs/planes/compras-backend.md`).
 *
 * El DDL vive en `db/migrations/0030_producto_entrada_compra.sql`.
 */
export class ProductoEntradaCompra1787000030000 implements MigrationInterface {
  name = 'ProductoEntradaCompra1787000030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0030_producto_entrada_compra'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE producto_movimiento DROP CONSTRAINT IF EXISTS ck_movimiento_tipo',
    );
    await queryRunner.query(
      `ALTER TABLE producto_movimiento ADD CONSTRAINT ck_movimiento_tipo CHECK (
         tipo IN ('ENTRADA_INICIAL', 'ENTRADA_AJUSTE', 'SALIDA_AJUSTE', 'SALIDA_VENTA')
       )`,
    );
  }
}
