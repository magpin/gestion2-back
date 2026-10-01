import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El saldo inicial de caja y bancos puede llevar su asiento de apertura (CA).
 *
 * El DDL vive en `db/migrations/0121_saldo_inicial_con_asiento.sql`.
 */
export class SaldoInicialConAsiento1787000121000 implements MigrationInterface {
  name = 'SaldoInicialConAsiento1787000121000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0121_saldo_inicial_con_asiento'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE caja_movimiento
         DROP CONSTRAINT ck_caja_mov_asiento,
         ADD CONSTRAINT ck_caja_mov_asiento CHECK (
           (tipo = 'SALDO_INICIAL' AND asiento_id IS NULL) OR
           (tipo <> 'SALDO_INICIAL' AND asiento_id IS NOT NULL));
       ALTER TABLE banco_movimiento
         DROP CONSTRAINT ck_banco_mov_asiento,
         ADD CONSTRAINT ck_banco_mov_asiento CHECK (
           (tipo = 'SALDO_INICIAL' AND asiento_id IS NULL) OR
           (tipo <> 'SALDO_INICIAL' AND asiento_id IS NOT NULL));`,
    );
  }
}
