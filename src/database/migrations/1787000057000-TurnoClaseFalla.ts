import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Por qué falló un turno del asistente: la clase de la falla y lo que dijo el
 * proveedor.
 *
 * El DDL vive en `db/migrations/0057_turno_clase_falla.sql`.
 */
export class TurnoClaseFalla1787000057000 implements MigrationInterface {
  name = 'TurnoClaseFalla1787000057000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0057_turno_clase_falla'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Se pierde por qué falló cada turno; el motivo para la persona se queda.
    await queryRunner.query(`
      ALTER TABLE conversacion_turno
        DROP CONSTRAINT IF EXISTS ck_conversacion_turno_clase,
        DROP CONSTRAINT IF EXISTS ck_conversacion_turno_detalle,
        DROP COLUMN IF EXISTS clase,
        DROP COLUMN IF EXISTS detalle;
    `);
  }
}
