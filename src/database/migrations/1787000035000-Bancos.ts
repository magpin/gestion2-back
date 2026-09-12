import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Parte B de Caja y Bancos (módulo 7): la cuenta bancaria (`cuenta_bancaria`),
 * su libro (`banco_movimiento`), el extracto (`extracto_bancario`) y sus
 * líneas (`extracto_linea`). Fase 2 del plan, detalle de sub-pasos en
 * `docs/planes/caja-bancos-fase2.md`.
 *
 * El DDL vive en `db/migrations/0035_bancos.sql`.
 */
export class Bancos1787000035000 implements MigrationInterface {
  name = 'Bancos1787000035000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0035_bancos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS extracto_linea');
    await queryRunner.query('DROP TABLE IF EXISTS extracto_bancario');
    await queryRunner.query('DROP TABLE IF EXISTS banco_movimiento');
    await queryRunner.query('DROP TABLE IF EXISTS cuenta_bancaria');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS fn_banco_movimiento_inmutable()',
    );
  }
}
