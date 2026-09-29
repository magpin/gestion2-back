import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Traslados entre caja y bancos: un documento, un asiento y un movimiento en
 * cada libro.
 *
 * El DDL vive en `db/migrations/0107_traslado.sql`.
 */
export class Traslado1787000107000 implements MigrationInterface {
  name = 'Traslado1787000107000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0107_traslado'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE traslado_consecutivo;
       DROP TABLE traslado;
       ALTER TABLE banco_movimiento DROP CONSTRAINT ck_banco_mov_origen_tipo;
       ALTER TABLE banco_movimiento ADD CONSTRAINT banco_movimiento_origen_tipo_check
         CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA'));
       ALTER TABLE caja_movimiento DROP CONSTRAINT ck_caja_mov_origen_tipo;
       ALTER TABLE caja_movimiento ADD CONSTRAINT caja_movimiento_origen_tipo_check
         CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA'));`,
    );
  }
}
