import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los renglones del formulario 350, con vigencia (plan motor de retenciones,
 * Fase 6, §6.2). Semilla propuesta, pendiente de Yeris (R-D15).
 *
 * El DDL vive en `db/migrations/0087_formulario_350.sql`.
 */
export class Formulario3501787000087000 implements MigrationInterface {
  name = 'Formulario3501787000087000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0087_formulario_350'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las corridas de los reportes nuevos no caben en el CHECK viejo: el down
    // falla si ya hay alguna, en vez de borrar el rastro.
    await queryRunner.query(`
      ALTER TABLE reporte_corrida DROP CONSTRAINT reporte_corrida_reporte_check;
      ALTER TABLE reporte_corrida ADD CONSTRAINT reporte_corrida_reporte_check CHECK (reporte IN (
        'VENTAS_POR_CLIENTE', 'ANTIGUEDAD_CARTERA', 'GUARDADO'
      ));
      DROP TABLE formulario_350_renglon;
    `);
  }
}
