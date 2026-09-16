import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La llave de la imagen del producto dentro del bucket.
 *
 * El DDL vive en `db/migrations/0042_imagen_producto.sql`.
 */
export class ImagenProducto1787000042000 implements MigrationInterface {
  name = 'ImagenProducto1787000042000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0042_imagen_producto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE producto DROP COLUMN imagen_clave');
  }
}
