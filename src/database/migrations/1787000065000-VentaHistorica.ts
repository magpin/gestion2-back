import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Facturas de venta históricas: las emitidas antes de usar el sistema.
 *
 * El DDL vive en `db/migrations/0065_venta_historica.sql`.
 */
export class VentaHistorica1787000065000 implements MigrationInterface {
  name = 'VentaHistorica1787000065000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0065_venta_historica'));
  }

  /** Bajarla falla si ya hay históricas: la regla fiscal vieja no las admite. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX ux_venta_numero;
      CREATE UNIQUE INDEX ux_venta_numero
        ON venta_documento (empresa_id, prefijo, consecutivo);
      ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_fiscal;
      ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_fiscal CHECK (
        (tipo = 'COTIZACION' AND resolucion_id IS NULL AND asiento_id IS NULL)
        OR
        (tipo <> 'COTIZACION' AND resolucion_id IS NOT NULL AND asiento_id IS NOT NULL)
      );
      ALTER TABLE venta_documento DROP COLUMN historica;
    `);
  }
}
