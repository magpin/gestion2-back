import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La nota débito de compra pasa por el motor de retenciones (plan motor de
 * retenciones, Fase 8, §8.7).
 *
 * El DDL vive en `db/migrations/0092_nota_debito_retencion.sql`.
 */
export class NotaDebitoRetencion1787000092000 implements MigrationInterface {
  name = 'NotaDebitoRetencion1787000092000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0092_nota_debito_retencion'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Falla si ya hay notas débito con entrada guardada: no se borran.
    await queryRunner.query(`
      ALTER TABLE retencion_documento_entrada
        DROP CONSTRAINT retencion_documento_entrada_documento_tipo_check;
      ALTER TABLE retencion_documento_entrada
        ADD CONSTRAINT retencion_documento_entrada_documento_tipo_check
          CHECK (documento_tipo IN ('COMPRA'));
    `);
  }
}
