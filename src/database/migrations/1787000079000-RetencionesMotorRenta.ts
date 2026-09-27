import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Motor de retenciones, Fase 1: renta en compras — lo calculado, lo aprendido
 * y el acumulado de honorarios.
 *
 * El DDL vive en `db/migrations/0079_retenciones_motor_renta.sql`.
 */
export class RetencionesMotorRenta1787000079000 implements MigrationInterface {
  name = 'RetencionesMotorRenta1787000079000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0079_retenciones_motor_renta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE compra_documento DROP COLUMN retencion_motivo, DROP COLUMN retencion_decision;
      ALTER TABLE compra_retencion
        DROP COLUMN retencion_calculada_id,
        DROP COLUMN tarifa,
        DROP COLUMN concepto_nacional_id,
        DROP COLUMN tipo;
      DROP TABLE retencion_acumulado;
      DROP TABLE retencion_mapeo_concepto;
      DROP TABLE retencion_calculada;
    `);
  }
}
