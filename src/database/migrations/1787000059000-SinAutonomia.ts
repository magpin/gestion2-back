import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * María no actúa sola: se retiran las reglas de autonomía.
 *
 * Antes de borrar nada, copia a `resuelta_por` quién activó la regla que
 * confirmó cada propuesta. Sin ese paso, las confirmadas solas quedarían sin
 * responsable atribuible.
 *
 * El DDL vive en `db/migrations/0059_sin_autonomia.sql`.
 */
export class SinAutonomia1787000059000 implements MigrationInterface {
  name = 'SinAutonomia1787000059000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0059_sin_autonomia'));
  }

  /**
   * Bajarla devuelve la tabla y la columna **vacías**: las reglas que había se
   * perdieron, y qué propuesta confirmó cuál no se puede reconstruir. Lo único
   * que sobrevive es quién fue responsable, que ya quedó en `resuelta_por`.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0053_asistente_regla'));
  }
}
