import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Retenciones: la aplicación solo lee la ley, y lo calculado es solo inserción.
 *
 * El DDL vive en `db/migrations/0080_retenciones_permisos.sql`.
 */
export class RetencionesPermisos1787000080000 implements MigrationInterface {
  name = 'RetencionesPermisos1787000080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0080_retenciones_permisos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER tg_retencion_calculada_inmutable ON retencion_calculada;
      DROP FUNCTION fn_retencion_calculada_inmutable();
      GRANT UPDATE ON retencion_calculada TO gestion_app, gestion_provision;
      GRANT INSERT, UPDATE ON retencion_concepto_nacional, retencion_tarifa,
        retencion_zomac_factor, retencion_migracion_registro TO gestion_app;
    `);
  }
}
