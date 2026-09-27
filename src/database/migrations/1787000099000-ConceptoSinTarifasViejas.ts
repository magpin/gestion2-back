import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los conceptos de la empresa ya no llevan tarifa: es de la ley (plan motor de
 * retenciones, Fase 7).
 *
 * El DDL vive en `db/migrations/0099_concepto_sin_tarifas_viejas.sql`. El
 * `down` devuelve las columnas con lo que tenían, desde el registro.
 */
export class ConceptoSinTarifasViejas1787000099000 implements MigrationInterface {
  name = 'ConceptoSinTarifasViejas1787000099000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0099_concepto_sin_tarifas_viejas'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE retencion_concepto
        ADD COLUMN tarifa numeric(7,4)
          CHECK (tarifa >= 0 AND tarifa <= 100),
        ADD COLUMN tarifa_no_declarante numeric(7,4)
          CHECK (tarifa_no_declarante IS NULL OR (tarifa_no_declarante >= 0 AND tarifa_no_declarante <= 100)),
        ADD COLUMN base_minima_uvt numeric(10,2)
          CHECK (base_minima_uvt >= 0),
        ADD CONSTRAINT ck_retencion_no_declarante
          CHECK (tarifa_no_declarante IS NULL OR tipo = 'RENTA');

      UPDATE retencion_concepto c
         SET tarifa = (r.detalle->>'tarifa')::numeric,
             tarifa_no_declarante = (r.detalle->>'tarifa_no_declarante')::numeric,
             base_minima_uvt = (r.detalle->>'base_minima_uvt')::numeric
        FROM retencion_migracion_registro r
       WHERE r.migracion = '0099' AND (r.detalle->>'concepto_id')::uuid = c.id;

      DELETE FROM retencion_migracion_registro WHERE migracion = '0099';
    `);
  }
}
