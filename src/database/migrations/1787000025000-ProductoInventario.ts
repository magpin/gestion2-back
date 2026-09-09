import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Modulo 3 de la secuencia: productos, su precio y el kardex.
 *
 * Cuatro tablas, dos historias que no se mezclan: `producto_precio` es
 * historia comercial (a cuanto se ofrecia), `producto_movimiento` es historia
 * de existencias y costo (cuanto hay y a que costo promedio). No hay una
 * quinta tabla de "saldo actual": el saldo vigente de un producto es la
 * ultima fila de su propio kardex.
 *
 * El DDL vive en `db/migrations/0025_producto_inventario.sql`.
 */
export class ProductoInventario1787000025000 implements MigrationInterface {
  name = 'ProductoInventario1787000025000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0025_producto_inventario'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS inventario_configuracion');
    await queryRunner.query('DROP TABLE IF EXISTS producto_movimiento');
    await queryRunner.query('DROP TABLE IF EXISTS producto_precio');
    await queryRunner.query('DROP TABLE IF EXISTS producto');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS fn_movimiento_inmutable()',
    );
  }
}
