import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Fase 0 de Caja y Bancos (módulo 7): dos ajustes a tablas de otros módulos,
 * ninguna tabla nueva. `empresa_sede` gana `UNIQUE (id, empresa_id)` — la FK
 * compuesta que `caja.sede_id` va a necesitar — y `asiento.origen_tipo` suma
 * `'MOVIMIENTO_CAJA'`/`'MOVIMIENTO_BANCO'`, nombrando de paso el CHECK que en
 * 0022 había quedado sin nombre propio.
 *
 * El DDL vive en `db/migrations/0032_tesoreria_prerrequisitos.sql`.
 */
export class TesoreriaPrerrequisitos1787000032000 implements MigrationInterface {
  name = 'TesoreriaPrerrequisitos1787000032000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0032_tesoreria_prerrequisitos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE asiento DROP CONSTRAINT IF EXISTS ck_asiento_origen_tipo',
    );
    await queryRunner.query(
      `ALTER TABLE asiento ADD CONSTRAINT asiento_origen_tipo_check
         CHECK (origen_tipo IN ('VENTA', 'COMPRA', 'NOMINA', 'AJUSTE_INVENTARIO'))`,
    );
    await queryRunner.query(
      'ALTER TABLE empresa_sede DROP CONSTRAINT IF EXISTS uq_sede_id_empresa',
    );
  }
}
