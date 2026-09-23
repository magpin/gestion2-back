import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El lote de documentos del chat, y descartar una lectura.
 *
 * El DDL vive en `db/migrations/0067_lote_lectura.sql`.
 */
export class LoteLectura1787000067000 implements MigrationInterface {
  name = 'LoteLectura1787000067000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0067_lote_lectura'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE documento_leido DROP CONSTRAINT IF EXISTS ck_documento_leido_descarte;
      ALTER TABLE documento_leido DROP CONSTRAINT ck_documento_leido_estado;
      ALTER TABLE documento_leido ADD CONSTRAINT ck_documento_leido_estado CHECK (
        CASE estado
          WHEN 'LEIDO' THEN extraido IS NOT NULL AND leido_en IS NOT NULL AND error IS NULL
          WHEN 'FALLO' THEN error    IS NOT NULL AND leido_en IS NOT NULL
          ELSE               error    IS NULL     AND leido_en IS NULL
        END
      );
      ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_estado_check;
      ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_estado_check
        CHECK (estado IN ('EN_COLA', 'LEYENDO', 'LEIDO', 'FALLO'));
      ALTER TABLE documento_leido
        DROP COLUMN motivo_descarte,
        DROP COLUMN descartado_por,
        DROP COLUMN descartado_en;
      DROP TABLE lote_archivo;
      DROP TABLE lote_lectura;
    `);
  }
}
