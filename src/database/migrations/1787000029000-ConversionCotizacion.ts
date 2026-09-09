import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Convertir una cotización en factura: `estado` suma `CONVERTIDA`,
 * `ck_venta_origen` se afloja para que una FACTURA pueda apuntar a la
 * cotización de la que vino (reusando `documento_origen_id`, sin columna
 * nueva), y `ck_venta_estado_tipo` ata qué estados puede tener cada tipo.
 *
 * El DDL vive en `db/migrations/0029_conversion_cotizacion.sql`.
 */
export class ConversionCotizacion1787000029000 implements MigrationInterface {
  name = 'ConversionCotizacion1787000029000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0029_conversion_cotizacion'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT IF EXISTS ck_venta_estado_tipo',
    );
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT IF EXISTS ck_venta_origen',
    );
    await queryRunner.query(
      `ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_origen CHECK (
         (tipo = 'NOTA_CREDITO') = (documento_origen_id IS NOT NULL)
       )`,
    );
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT IF EXISTS ck_venta_estado',
    );
    await queryRunner.query(
      `ALTER TABLE venta_documento ADD CONSTRAINT venta_documento_estado_check CHECK (
         estado = ANY (ARRAY['BORRADOR'::text, 'EMITIDA'::text, 'ANULADA'::text])
       )`,
    );
  }
}
