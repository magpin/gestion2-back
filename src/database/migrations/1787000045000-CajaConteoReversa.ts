import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El conteo de un arqueo por denominaciones, y la reversa de un movimiento de
 * caja mal cargado.
 *
 * El DDL vive en `db/migrations/0045_caja_conteo_reversa.sql`.
 */
export class CajaConteoReversa1787000045000 implements MigrationInterface {
  name = 'CajaConteoReversa1787000045000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0045_caja_conteo_reversa'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS tg_caja_reversa_valida ON caja_movimiento',
    );
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_caja_reversa_valida()');
    await queryRunner.query('DROP INDEX IF EXISTS ux_caja_mov_reversa');
    await queryRunner.query(
      `ALTER TABLE caja_movimiento
         DROP CONSTRAINT IF EXISTS ck_caja_mov_reversa,
         DROP CONSTRAINT IF EXISTS fk_caja_mov_reversa,
         DROP COLUMN IF EXISTS motivo_reversa,
         DROP COLUMN IF EXISTS reversa_de`,
    );
    await queryRunner.query(
      'ALTER TABLE caja_movimiento DROP CONSTRAINT IF EXISTS uq_caja_mov_id_empresa',
    );
    await queryRunner.query('DROP TABLE IF EXISTS caja_arqueo_denominacion');
    await queryRunner.query(
      'ALTER TABLE caja_arqueo DROP CONSTRAINT IF EXISTS uq_arqueo_id_empresa',
    );
  }
}
