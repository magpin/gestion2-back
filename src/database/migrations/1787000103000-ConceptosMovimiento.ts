import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Conceptos de ingreso y egreso (lo que se elige en vez de una cuenta), el
 * concepto en la línea del asiento, vencimientos de facturas, pronto pago de
 * la compra y la cuenta bancaria exenta del 4×1000.
 *
 * El DDL vive en `db/migrations/0103_conceptos_movimiento.sql`.
 */
export class ConceptosMovimiento1787000103000 implements MigrationInterface {
  name = 'ConceptosMovimiento1787000103000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0103_conceptos_movimiento'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cuenta_bancaria DROP COLUMN exenta_gmf;
       ALTER TABLE compra_documento
         DROP CONSTRAINT ck_compra_descuento_pp,
         DROP COLUMN descuento_pp_pct,
         DROP COLUMN descuento_pp_hasta,
         DROP CONSTRAINT ck_compra_vence,
         DROP COLUMN vence;
       ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_vence, DROP COLUMN vence;
       ALTER TABLE asiento_linea DROP CONSTRAINT fk_linea_concepto, DROP COLUMN concepto_id;
       DROP TABLE concepto_movimiento;`,
    );
  }
}
