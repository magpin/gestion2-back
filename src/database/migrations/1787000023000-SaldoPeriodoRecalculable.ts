import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Reabrir un periodo borra sus saldos congelados.
 *
 * `0022` dejo `saldo_cuenta_periodo` sin DELETE por la regla de que nada se
 * borra. Escribiendo `periodo.service.reabrir()` quedo claro que ahi la regla no
 * aplica: un asiento es un hecho, un saldo congelado es un calculo derivado de
 * ese hecho. Dejarlo seria peor —el mes siguiente arrancaria de un saldo inicial
 * que ya nadie recalculo—.
 *
 * El DDL vive en `db/migrations/0023_saldo_periodo_recalculable.sql`.
 */
export class SaldoPeriodoRecalculable1787000023000 implements MigrationInterface {
  name = 'SaldoPeriodoRecalculable1787000023000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0023_saldo_periodo_recalculable'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'REVOKE DELETE ON saldo_cuenta_periodo FROM gestion_app',
    );
  }
}
