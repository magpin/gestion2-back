import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El concepto como fuente de clasificación de la retención (PC23).
 *
 * El DDL vive en `db/migrations/0120_origen_concepto.sql`.
 */
export class OrigenConcepto1787000120000 implements MigrationInterface {
  name = 'OrigenConcepto1787000120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0120_origen_concepto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE retencion_clasificacion_uso
         DROP CONSTRAINT retencion_clasificacion_uso_origen_propuesto_check,
         ADD CONSTRAINT retencion_clasificacion_uso_origen_propuesto_check CHECK (origen_propuesto IS NULL OR origen_propuesto IN
           ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA'));
       ALTER TABLE retencion_calculada
         DROP CONSTRAINT retencion_calculada_origen_clasificacion_check,
         ADD CONSTRAINT retencion_calculada_origen_clasificacion_check CHECK (origen_clasificacion IN
           ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA', 'MANUAL'));`,
    );
  }
}
