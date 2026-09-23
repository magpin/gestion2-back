import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * `documento_leido` acepta una factura de compra: un tipo más, lo extraído como
 * objeto, y varias facturas leyéndose a la vez.
 *
 * El DDL vive en `db/migrations/0061_lectura_factura_compra.sql`.
 */
export class LecturaFacturaCompra1787000061000 implements MigrationInterface {
  name = 'LecturaFacturaCompra1787000061000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0061_lectura_factura_compra'));
  }

  /**
   * Bajarla **falla si ya se leyó alguna factura**, y tiene que ser así: el
   * CHECK viejo no admite el tipo, y el índice viejo no admite dos lecturas en
   * curso del mismo tipo. Borrar esas filas para que el esquema encaje sería
   * tirar el historial de lo que costó cada lectura, que es justamente lo que
   * la tabla existe para conservar.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_documento_leido_en_curso;
      CREATE UNIQUE INDEX uq_documento_leido_en_curso
        ON documento_leido (empresa_id, tipo)
        WHERE estado IN ('EN_COLA', 'LEYENDO');

      ALTER TABLE documento_leido
        DROP CONSTRAINT documento_leido_extraido_check,
        ADD  CONSTRAINT documento_leido_extraido_check
             CHECK (extraido IS NULL OR jsonb_typeof(extraido) = 'array'),
        DROP CONSTRAINT documento_leido_tipo_check,
        ADD  CONSTRAINT documento_leido_tipo_check
             CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN'));
    `);
  }
}
