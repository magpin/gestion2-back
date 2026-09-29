import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los estados financieros quedan en el rastro de corridas.
 *
 * El DDL vive en `db/migrations/0109_corridas_estados_financieros.sql`.
 */
export class CorridasEstadosFinancieros1787000109000 implements MigrationInterface {
  name = 'CorridasEstadosFinancieros1787000109000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0109_corridas_estados_financieros'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM reporte_corrida
        WHERE reporte IN ('ESTADO_RESULTADOS', 'BALANCE_GENERAL', 'FLUJO_CAJA');
       ALTER TABLE reporte_corrida DROP CONSTRAINT reporte_corrida_reporte_check;
       ALTER TABLE reporte_corrida ADD CONSTRAINT reporte_corrida_reporte_check CHECK (reporte IN (
         'VENTAS_POR_CLIENTE', 'ANTIGUEDAD_CARTERA', 'GUARDADO',
         'RETENCIONES_350', 'RETEICA', 'CERTIFICADOS_RETENCION'
       ));`,
    );
  }
}
