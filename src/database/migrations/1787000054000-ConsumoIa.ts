import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lo que falta para medir el consumo de la IA: el uso, el modelo y la
 * duración de la lectura de documentos, y la duración y las vueltas de cada
 * respuesta del chat.
 *
 * El DDL vive en `db/migrations/0054_consumo_ia.sql`.
 */
export class ConsumoIa1787000054000 implements MigrationInterface {
  name = 'ConsumoIa1787000054000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0054_consumo_ia'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Solo columnas nuevas y opcionales: lo que se pierde es la medición.
    await queryRunner.query(`
      ALTER TABLE conversacion_turno
        DROP CONSTRAINT IF EXISTS ck_conversacion_turno_vueltas,
        DROP CONSTRAINT IF EXISTS ck_conversacion_turno_duracion,
        DROP COLUMN IF EXISTS vueltas,
        DROP COLUMN IF EXISTS duracion_ms;
      ALTER TABLE documento_leido
        DROP CONSTRAINT IF EXISTS ck_documento_leido_duracion,
        DROP CONSTRAINT IF EXISTS ck_documento_leido_uso,
        DROP COLUMN IF EXISTS duracion_ms,
        DROP COLUMN IF EXISTS modelo,
        DROP COLUMN IF EXISTS uso;
    `);
  }
}
