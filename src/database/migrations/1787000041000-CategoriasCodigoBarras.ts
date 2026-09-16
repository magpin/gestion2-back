import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Categorías de producto y código de barras.
 *
 * El DDL vive en `db/migrations/0041_categorias_codigo_barras.sql`.
 */
export class CategoriasCodigoBarras1787000041000 implements MigrationInterface {
  name = 'CategoriasCodigoBarras1787000041000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0041_categorias_codigo_barras'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_producto_codigo_barras');
    await queryRunner.query(
      'ALTER TABLE producto DROP COLUMN codigo_barras, DROP CONSTRAINT fk_producto_categoria, DROP COLUMN categoria_id',
    );
    await queryRunner.query('DROP INDEX ix_producto_categoria');
    await queryRunner.query('DROP TABLE producto_categoria');
  }
}
