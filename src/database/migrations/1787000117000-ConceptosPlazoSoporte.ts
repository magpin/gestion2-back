import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Conceptos con sugerencias para el motor, plazo por tercero y documento
 * soporte en la compra.
 *
 * El DDL vive en `db/migrations/0117_conceptos_plazo_soporte.sql`.
 */
export class ConceptosPlazoSoporte1787000117000 implements MigrationInterface {
  name = 'ConceptosPlazoSoporte1787000117000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0117_conceptos_plazo_soporte'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE compra_documento DROP CONSTRAINT ck_compra_soporte,
         DROP COLUMN cufe, DROP COLUMN transmision, DROP COLUMN clase_documento;
       ALTER TABLE tercero DROP COLUMN dias_plazo_proveedor, DROP COLUMN dias_plazo_cliente;
       ALTER TABLE concepto_movimiento DROP COLUMN deducible, DROP COLUMN aplica_reteica,
         DROP COLUMN retencion_sugerida, DROP COLUMN iva_compra;`,
    );
  }
}
