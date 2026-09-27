import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La nota crédito de venta reversa su autorretención (plan motor de
 * retenciones, Fase 6, §6.0).
 *
 * El DDL vive en `db/migrations/0086_reversa_autorretencion.sql`.
 */
export class ReversaAutorretencion1787000086000 implements MigrationInterface {
  name = 'ReversaAutorretencion1787000086000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0086_reversa_autorretencion'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las reversas de notas crédito de venta no caben en el CHECK viejo: el
    // down no las borra (la tabla es de solo inserción) y falla si las hay.
    await queryRunner.query(`
      ALTER TABLE retencion_calculada
        DROP CONSTRAINT retencion_calculada_documento_tipo_check;
      ALTER TABLE retencion_calculada
        ADD CONSTRAINT retencion_calculada_documento_tipo_check CHECK (documento_tipo IN
          ('COMPRA', 'NOTA_CREDITO_COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA'));
    `);
  }
}
