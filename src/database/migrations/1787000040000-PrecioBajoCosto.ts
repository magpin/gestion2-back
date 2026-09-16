import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Quién autorizó vender una línea por debajo de su costo.
 *
 * El DDL vive en `db/migrations/0040_precio_bajo_costo.sql`.
 */
export class PrecioBajoCosto1787000040000 implements MigrationInterface {
  name = 'PrecioBajoCosto1787000040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0040_precio_bajo_costo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX ix_venta_linea_bajo_costo');
    await queryRunner.query(
      'ALTER TABLE venta_documento_linea DROP COLUMN precio_bajo_costo_autorizado_por',
    );
  }
}
