import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El catálogo de retenciones —UVT por año, conceptos con tarifa y base mínima—,
 * si el tercero declara renta, y las retenciones que nos practican en una venta.
 *
 * El DDL vive en `db/migrations/0043_retenciones.sql`.
 */
export class Retenciones1787000043000 implements MigrationInterface {
  name = 'Retenciones1787000043000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0043_retenciones'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE venta_retencion');
    await queryRunner.query('ALTER TABLE tercero DROP COLUMN declarante_renta');
    await queryRunner.query('DROP TABLE retencion_concepto');
    await queryRunner.query('DROP TABLE uvt');
  }
}
