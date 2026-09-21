import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lo que el asistente propone hacer —un cobro, un pago— y lo que la persona
 * decidió. Se resuelve una sola vez.
 *
 * El DDL vive en `db/migrations/0052_asistente_propuesta.sql`.
 */
export class AsistentePropuesta1787000052000 implements MigrationInterface {
  name = 'AsistentePropuesta1787000052000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0052_asistente_propuesta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Una tabla nueva y sus funciones; nadie más las referencia. Lo que se
    // pierde es el registro de lo propuesto; lo que se confirmó ya está en
    // sus documentos y asientos.
    await queryRunner.query(`
      DROP TABLE IF EXISTS asistente_propuesta;
      DROP FUNCTION IF EXISTS fn_asistente_propuesta_una_vez();
      DROP FUNCTION IF EXISTS fn_asistente_propuesta_turno();
    `);
  }
}
