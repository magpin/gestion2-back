import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Pagos: comprobante de egreso, cruce de anticipos a proveedores y pagos
 * programados.
 *
 * El DDL vive en `db/migrations/0106_comprobante_egreso.sql`.
 */
export class ComprobanteEgreso1787000106000 implements MigrationInterface {
  name = 'ComprobanteEgreso1787000106000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0106_comprobante_egreso'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE pago_programado;
       DROP TABLE cruce_pago;
       DROP TABLE comprobante_egreso_consecutivo;
       DROP TABLE comprobante_egreso_aplicacion;
       DROP TABLE comprobante_egreso;`,
    );
  }
}
