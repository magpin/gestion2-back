import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Retenciones: lo de cada empresa enlazado a la ley, y el perfil tributario del
 * tercero con historia (plan motor de retenciones, Fase 0).
 *
 * El DDL vive en `db/migrations/0075_retenciones_empresa.sql`.
 */
export class RetencionesEmpresa1787000075000 implements MigrationInterface {
  name = 'RetencionesEmpresa1787000075000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0075_retenciones_empresa'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER tg_tercero_sincroniza_perfil ON tercero;
      DROP FUNCTION fn_tercero_sincroniza_perfil();
      DROP TABLE tercero_perfil_tributario;
      ALTER TABLE compra_retencion ADD CONSTRAINT compra_retencion_concepto_check
        CHECK (concepto IN ('HONORARIOS', 'COMISIONES', 'SERVICIOS', 'ARRENDAMIENTOS', 'COMPRAS', 'OTROS')) NOT VALID;
      GRANT INSERT, UPDATE ON uvt TO gestion_app;
      DROP INDEX ux_retencion_concepto_nacional;
      -- Los enlaces que creó el sistema no tienen año ni tarifa: no caben en
      -- la tabla vieja.
      DELETE FROM retencion_concepto WHERE anio IS NULL;
      ALTER TABLE retencion_concepto
        ALTER COLUMN anio            SET NOT NULL,
        ALTER COLUMN tarifa          SET NOT NULL,
        ALTER COLUMN base_minima_uvt SET NOT NULL;
      ALTER TABLE retencion_concepto DROP COLUMN sin_equivalente, DROP COLUMN concepto_nacional_id;
      DELETE FROM retencion_migracion_registro WHERE migracion = '0075';
    `);
  }
}
