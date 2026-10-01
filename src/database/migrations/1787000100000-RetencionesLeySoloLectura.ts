import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Retenciones: la aplicación solo lee las tablas de ley que llegaron después
 * de la 0080 (casillas del 350, tabla 383, parámetros de ley, convenios) y solo
 * ve los recálculos de su empresa.
 *
 * El DDL vive en `db/migrations/0100_retenciones_ley_solo_lectura.sql`.
 */
export class RetencionesLeySoloLectura1787000100000 implements MigrationInterface {
  name = 'RetencionesLeySoloLectura1787000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0100_retenciones_ley_solo_lectura'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP POLICY p_retencion_recalculo_propio ON retencion_recalculo;
      ALTER TABLE retencion_recalculo NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE retencion_recalculo DISABLE ROW LEVEL SECURITY;
      REVOKE SELECT (id, desde, hasta, empresa_id, motivo, creado_en)
        ON retencion_recalculo FROM gestion_app;
      GRANT SELECT, INSERT, UPDATE ON retencion_recalculo TO gestion_app;
      GRANT INSERT, UPDATE ON formulario_350_renglon, retencion_tabla_383,
        retencion_parametro_ley, cdi_tarifa TO gestion_app;
    `);
  }
}
