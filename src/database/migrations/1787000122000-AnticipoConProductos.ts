import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El anticipo con sus productos, y el cruce aplicado al emitir la factura.
 *
 * El DDL vive en `db/migrations/0122_anticipo_con_productos.sql`.
 */
export class AnticipoConProductos1787000122000 implements MigrationInterface {
  name = 'AnticipoConProductos1787000122000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0122_anticipo_con_productos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cruce_cartera DROP COLUMN en_factura;
       DROP TABLE recibo_caja_anticipo_linea;`,
    );
  }
}
