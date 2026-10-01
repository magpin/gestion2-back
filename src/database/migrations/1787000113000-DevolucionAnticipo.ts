import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Devolver un anticipo: el movimiento que lo devuelve dice a cuál descuenta.
 *
 * El DDL vive en `db/migrations/0113_devolucion_anticipo.sql`.
 */
export class DevolucionAnticipo1787000113000 implements MigrationInterface {
  name = 'DevolucionAnticipo1787000113000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0113_devolucion_anticipo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE movimiento_concepto
         DROP CONSTRAINT ck_movimiento_concepto_devuelve,
         DROP CONSTRAINT fk_movimiento_concepto_devuelve,
         DROP COLUMN devuelve_a,
         DROP CONSTRAINT movimiento_concepto_origen_check,
         ADD CONSTRAINT movimiento_concepto_origen_check CHECK (origen IN
           ('MANUAL', 'RECIBO_CAJA', 'COMPROBANTE_EGRESO', 'GMF'));`,
    );
  }
}
