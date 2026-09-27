import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * ReteICA de Bogotá, Cali, Bucaramanga y Pereira (plan motor de retenciones,
 * Fase 8). El SQL lo genera `scripts/generar-seed-reteica.js` a partir de
 * `db/datos/reteica/`.
 *
 * El DDL vive en `db/migrations/0093_reteica_municipios.sql`.
 */
export class ReteicaMunicipios1787000093000 implements MigrationInterface {
  name = 'ReteicaMunicipios1787000093000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0093_reteica_municipios'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM ica_tarifa
       WHERE validado_en = '2026-09-26' AND validado_por LIKE 'Claude%';
      DELETE FROM ica_matriz_agente
       WHERE (municipio_codigo, anio) IN (('11001', 2026), ('76001', 2027));
      DELETE FROM ica_parametro
       WHERE validado_en = '2026-09-26' AND validado_por LIKE 'Claude%';
      ALTER TABLE ica_tarifa DROP CONSTRAINT ck_ica_tarifa_rango;
      ALTER TABLE ica_tarifa ADD CONSTRAINT ck_ica_tarifa_rango CHECK (
        tipo = 'FINANCIERA'
        OR (tipo = 'INDUSTRIAL' AND tarifa_por_mil BETWEEN 2 AND 7)
        OR (tipo IN ('COMERCIAL', 'SERVICIOS') AND tarifa_por_mil BETWEEN 2 AND 10));
    `);
  }
}
