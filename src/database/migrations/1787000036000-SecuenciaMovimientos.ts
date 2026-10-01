import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * `secuencia` en `producto_movimiento`, `caja_movimiento` y
 * `banco_movimiento`: el orden real de los movimientos, asignado al insertar
 * dentro del candado. Ordenar el saldo corrido por `creado_en` —la hora de
 * inicio de la transacción— dejaba saldos rotos con operaciones simultáneas.
 * Recalcula los saldos existentes en el orden nuevo.
 *
 * El DDL vive en `db/migrations/0036_secuencia_movimientos.sql`.
 */
export class SecuenciaMovimientos1787000036000 implements MigrationInterface {
  name = 'SecuenciaMovimientos1787000036000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0036_secuencia_movimientos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Los saldos recalculados se quedan: eran los correctos. Solo se va la columna.
    await queryRunner.query(
      'ALTER TABLE producto_movimiento DROP COLUMN secuencia',
    );
    await queryRunner.query(
      'ALTER TABLE caja_movimiento DROP COLUMN secuencia',
    );
    await queryRunner.query(
      'ALTER TABLE banco_movimiento DROP COLUMN secuencia',
    );
  }
}
