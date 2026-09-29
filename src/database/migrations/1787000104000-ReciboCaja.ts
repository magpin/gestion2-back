import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Recibo de caja: agrupa los cobros de una o varias facturas de un cliente en
 * un solo documento numerado.
 *
 * El DDL vive en `db/migrations/0104_recibo_caja.sql`.
 */
export class ReciboCaja1787000104000 implements MigrationInterface {
  name = 'ReciboCaja1787000104000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0104_recibo_caja'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE recibo_caja_consecutivo;
       DROP TABLE recibo_caja_aplicacion;
       DROP TABLE recibo_caja;`,
    );
  }
}
