import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los datos tributarios del tercero viven solo en su perfil (plan motor de
 * retenciones, Fase 7).
 *
 * El DDL vive en `db/migrations/0098_tercero_sin_columnas_tributarias.sql`. El
 * `down` devuelve las columnas llenas con el perfil vigente y el trigger de la
 * 0081; las versiones que abrió el «agente retenedor» se quedan.
 */
export class TerceroSinColumnasTributarias1787000098000 implements MigrationInterface {
  name = 'TerceroSinColumnasTributarias1787000098000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0098_tercero_sin_columnas_tributarias'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tercero
        ADD COLUMN responsable_iva       boolean NOT NULL DEFAULT false,
        ADD COLUMN es_agente_retenedor   boolean NOT NULL DEFAULT false,
        ADD COLUMN es_autorretenedor     boolean NOT NULL DEFAULT false,
        ADD COLUMN es_gran_contribuyente boolean NOT NULL DEFAULT false,
        ADD COLUMN regimen_simple        boolean NOT NULL DEFAULT false,
        ADD COLUMN declarante_renta      boolean NOT NULL DEFAULT true;

      UPDATE tercero t
         SET responsable_iva = p.es_responsable_iva,
             es_agente_retenedor = p.es_agente_ret_renta,
             es_autorretenedor = p.es_autorretenedor_renta,
             es_gran_contribuyente = p.es_gran_contribuyente,
             regimen_simple = (p.regimen_renta = 'SIMPLE'),
             declarante_renta = p.declarante_renta
        FROM tercero_perfil_tributario p
       WHERE p.tercero_id = t.id AND p.vigencia_hasta IS NULL;

      DELETE FROM retencion_migracion_registro WHERE migracion = '0098';
    `);
    await queryRunner.query(leerSql('0081_perfil_tercero_directo'));
    await queryRunner.query(`
      CREATE TRIGGER tg_tercero_sincroniza_perfil
        AFTER INSERT OR UPDATE ON tercero
        FOR EACH ROW EXECUTE FUNCTION fn_tercero_sincroniza_perfil();
    `);
  }
}
