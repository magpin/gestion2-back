import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El marco donde van a caer los asientos.
 *
 * Dos tablas que no guardan un solo movimiento y que aun asi tienen que existir
 * antes que el libro: en que mes cae cada asiento, y de donde sale su numero.
 * Las dos son FK de `asiento`, asi que van primero.
 *
 * El `down()` borra las dos. Es simetrico solo mientras no haya asientos: en
 * cuanto los haya, las FK lo impiden, que es exactamente lo que se busca.
 *
 * El DDL vive en `db/migrations/0021_periodo_comprobante.sql`.
 */
export class PeriodoComprobante1787000021000 implements MigrationInterface {
  name = 'PeriodoComprobante1787000021000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0021_periodo_comprobante'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS empresa_comprobante_tipo');
    await queryRunner.query('DROP TABLE IF EXISTS periodo_contable');
  }
}
