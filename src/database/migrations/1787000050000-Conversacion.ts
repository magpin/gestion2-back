import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Conversar con el asistente: las conversaciones de cada persona y sus turnos,
 * que solo se agregan.
 *
 * El DDL vive en `db/migrations/0050_conversacion.sql`.
 */
export class Conversacion1787000050000 implements MigrationInterface {
  name = 'Conversacion1787000050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0050_conversacion'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dos tablas nuevas y sus funciones; nadie más las referencia. Lo que se
    // pierde es lo conversado, que no es configuración ni dato contable.
    await queryRunner.query(`
      DROP TABLE IF EXISTS conversacion_turno;
      DROP TABLE IF EXISTS conversacion;
      DROP FUNCTION IF EXISTS fn_conversacion_turno_vigente();
      DROP FUNCTION IF EXISTS fn_conversacion_solo_archivar();
    `);
  }
}
