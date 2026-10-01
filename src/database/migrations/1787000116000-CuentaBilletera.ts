import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Nequi y Daviplata como tipo de cuenta BILLETERA.
 *
 * El DDL vive en `db/migrations/0116_cuenta_billetera.sql`.
 */
export class CuentaBilletera1787000116000 implements MigrationInterface {
  name = 'CuentaBilletera1787000116000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0116_cuenta_billetera'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE cuenta_bancaria
         DROP CONSTRAINT cuenta_bancaria_tipo_cuenta_check,
         ADD CONSTRAINT cuenta_bancaria_tipo_cuenta_check
           CHECK (tipo_cuenta IN ('AHORROS', 'CORRIENTE'));`,
    );
  }
}
