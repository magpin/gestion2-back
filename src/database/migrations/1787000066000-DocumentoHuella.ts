import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La huella sha256 del documento soporte.
 *
 * El DDL vive en `db/migrations/0066_documento_huella.sql`.
 */
export class DocumentoHuella1787000066000 implements MigrationInterface {
  name = 'DocumentoHuella1787000066000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0066_documento_huella'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE documento_leido DROP COLUMN IF EXISTS huella_sha256;`,
    );
  }
}
