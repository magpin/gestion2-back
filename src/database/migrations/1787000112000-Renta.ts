import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Renta: ZOMAC de la empresa, los renglones del 110 que usa el año siguiente
 * y el pago por cuotas.
 *
 * El DDL vive en `db/migrations/0112_renta.sql`.
 */
export class Renta1787000112000 implements MigrationInterface {
  name = 'Renta1787000112000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0112_renta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE declaracion_pago;
       ALTER TABLE declaracion DROP CONSTRAINT ck_declaracion_renta,
         DROP COLUMN impuesto_neto, DROP COLUMN anticipo_siguiente, DROP COLUMN cuotas;
       ALTER TABLE empresa_impuesto_config DROP COLUMN zomac_tamano;`,
    );
  }
}
