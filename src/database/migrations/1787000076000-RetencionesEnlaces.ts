import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Retenciones: los enlaces concepto de la ley → cuenta de la empresa los crea
 * el sistema (plan motor de retenciones, Fase 0, §0.7.5).
 *
 * El DDL vive en `db/migrations/0076_retenciones_enlaces.sql`.
 */
export class RetencionesEnlaces1787000076000 implements MigrationInterface {
  name = 'RetencionesEnlaces1787000076000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0076_retenciones_enlaces'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER tg_empresa_cuenta_enlaza_retencion ON empresa_cuenta;
      DROP FUNCTION fn_empresa_cuenta_enlaza_retencion();
      DROP FUNCTION fn_retencion_enlaza(uuid);
      DROP FUNCTION fn_retencion_cuenta_de(uuid, varchar);
      -- Los enlaces que creó el sistema (sin autor) se van: los vuelve a crear
      -- el trigger si se corre otra vez.
      DELETE FROM retencion_concepto WHERE creado_por IS NULL;
      ALTER TABLE retencion_concepto
        DROP CONSTRAINT ck_retencion_alguna_cuenta,
        DROP CONSTRAINT fk_retencion_cuenta_activo,
        DROP COLUMN cuenta_activo_id,
        ALTER COLUMN cuenta_id SET NOT NULL;
      ALTER TABLE retencion_concepto ALTER COLUMN creado_por SET NOT NULL;
      DELETE FROM retencion_migracion_registro WHERE migracion = '0076';
    `);
  }
}
