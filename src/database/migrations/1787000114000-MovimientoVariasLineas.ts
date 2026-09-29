import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * «Sin factura» con varias líneas, y el pago de IVA e ICA solo desde Impuestos.
 *
 * El DDL vive en `db/migrations/0114_movimiento_varias_lineas.sql`.
 */
export class MovimientoVariasLineas1787000114000 implements MigrationInterface {
  name = 'MovimientoVariasLineas1787000114000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0114_movimiento_varias_lineas'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE concepto_movimiento SET automatico = false
        WHERE es_sistema AND codigo IN ('NG-PAGO-IVA', 'NG-PAGO-ICA');
       DROP TABLE movimiento_concepto_linea;`,
    );
  }
}
