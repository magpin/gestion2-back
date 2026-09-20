import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lectura de documentos: lo que el asistente leyó de un RUT, una Cámara de
 * Comercio o una resolución DIAN, antes de que una persona lo confirme.
 *
 * El DDL vive en `db/migrations/0048_lectura_documentos.sql`.
 */
export class LecturaDocumentos1787000048000 implements MigrationInterface {
  name = 'LecturaDocumentos1787000048000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0048_lectura_documentos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Una tabla nueva y nada más: nadie la referencia, y lo que guarda son
    // propuestas sin aplicar. Lo confirmado vive en las tablas de configuración
    // y no se va con esto.
    await queryRunner.query('DROP TABLE IF EXISTS documento_leido');
  }
}
