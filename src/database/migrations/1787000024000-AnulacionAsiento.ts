import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La anulacion tiene columnas propias.
 *
 * `0022` dejo dos reglas que se contradecian sin que se notara hasta
 * ejercitarlas: el trigger de inmutabilidad permitia cambiar solo el estado, y
 * `anular()` cambiaba el estado y ademas metia el motivo en la glosa. Anular era
 * imposible: el trigger rechazaba su propio caso de uso.
 *
 * Se arregla por el lado estricto. La glosa dice por que EXISTE el asiento y no
 * cambia nunca; por que se ANULO es otro hecho, de otro momento y de otra
 * persona. Meterlo en la glosa perdia quien lo anulo y cuando, que es lo primero
 * que pregunta un auditor.
 *
 * El DDL vive en `db/migrations/0024_anulacion_asiento.sql`.
 */
export class AnulacionAsiento1787000024000 implements MigrationInterface {
  name = 'AnulacionAsiento1787000024000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0024_anulacion_asiento'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE asiento DROP CONSTRAINT IF EXISTS ck_asiento_anulacion',
    );
    await queryRunner.query(
      'ALTER TABLE asiento DROP COLUMN IF EXISTS motivo_anulacion, DROP COLUMN IF EXISTS anulado_en, DROP COLUMN IF EXISTS anulado_por',
    );
  }
}
