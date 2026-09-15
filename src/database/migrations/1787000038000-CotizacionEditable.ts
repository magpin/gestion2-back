import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Corregir y descartar una cotización: `ck_venta_estado_tipo` acepta
 * `ANULADA` en `COTIZACION`, y `tg_linea_venta_inmutable` pasa a usar una
 * función propia que deja borrar las líneas de una cotización vigente —las de
 * un documento fiscal siguen intocables, y el UPDATE sigue prohibido para
 * todos—.
 *
 * El DDL vive en `db/migrations/0038_cotizacion_editable.sql`.
 */
export class CotizacionEditable1787000038000 implements MigrationInterface {
  name = 'CotizacionEditable1787000038000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0038_cotizacion_editable'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'REVOKE DELETE ON venta_documento_linea FROM gestion_app',
    );
    await queryRunner.query(
      'DROP TRIGGER tg_linea_venta_borrable ON venta_documento_linea',
    );
    await queryRunner.query('DROP FUNCTION fn_linea_venta_borrable()');
    // Si alguna cotización quedó ANULADA, este revert falla — y es lo
    // correcto: el estado ya existe en los datos.
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_estado_tipo',
    );
    await queryRunner.query(`ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_estado_tipo CHECK (
      (tipo = 'COTIZACION' AND estado IN ('BORRADOR', 'EMITIDA', 'CONVERTIDA'))
      OR (tipo <> 'COTIZACION' AND estado IN ('EMITIDA', 'ANULADA'))
    )`);
  }
}
