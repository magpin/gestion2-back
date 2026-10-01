import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El recálculo por cambio de norma también cubre las ventas (plan motor de
 * retenciones, Fase 8, §8.10).
 *
 * El DDL vive en `db/migrations/0097_recalculo_ventas.sql`.
 */
export class RecalculoVentas1787000097000 implements MigrationInterface {
  name = 'RecalculoVentas1787000097000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0097_recalculo_ventas'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Falla si ya hay ventas con entrada o diferencias: no se borran.
    await queryRunner.query(`
      ALTER TABLE retencion_recalculo_diferencia
        DROP CONSTRAINT retencion_recalculo_diferencia_documento_tipo_check;
      ALTER TABLE retencion_recalculo_diferencia
        ADD CONSTRAINT retencion_recalculo_diferencia_documento_tipo_check
          CHECK (documento_tipo IN ('COMPRA'));
      ALTER TABLE retencion_documento_entrada
        DROP CONSTRAINT retencion_documento_entrada_documento_tipo_check;
      ALTER TABLE retencion_documento_entrada
        ADD CONSTRAINT retencion_documento_entrada_documento_tipo_check
          CHECK (documento_tipo IN ('COMPRA', 'NOTA_DEBITO_COMPRA'));
    `);
  }
}
