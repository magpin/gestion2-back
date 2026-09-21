import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Qué consultó el asistente para cada respuesta: la herramienta y lo que
 * pidió, no las filas que devolvió. Solo se agrega.
 *
 * El DDL vive en `db/migrations/0051_conversacion_consulta.sql`.
 */
export class ConversacionConsulta1787000051000 implements MigrationInterface {
  name = 'ConversacionConsulta1787000051000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0051_conversacion_consulta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Una tabla nueva y su función; nadie más las referencia. Lo que se pierde
    // es de dónde salió cada cifra de lo conversado, no un dato contable.
    await queryRunner.query(`
      DROP TABLE IF EXISTS conversacion_consulta;
      DROP FUNCTION IF EXISTS fn_conversacion_consulta_turno();
    `);
  }
}
