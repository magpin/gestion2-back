import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Módulo 4 de la secuencia: cotización, factura de venta y nota crédito.
 *
 * Un solo tipo de documento (`venta_documento.tipo`), no tres tablas: las
 * tres comparten cabecera y líneas, lo que cambia es la regla del servicio
 * (si numera con resolución DIAN, si asienta, si mueve inventario). El
 * modelo completo, con el porqué de cada decisión, vive en
 * `docs/planes/ventas-backend.md`.
 *
 * De paso agrega la FK compuesta `(id, empresa_id)` que le faltaba a
 * `tercero` y a `empresa_resolucion_dian` — el resto del esquema la exige
 * en toda referencia cruzada entre tablas, y estas dos se quedaron con solo
 * PK simple porque nadie las había necesitado así hasta ahora.
 *
 * El DDL vive en `db/migrations/0027_ventas.sql`.
 */
export class Ventas1787000027000 implements MigrationInterface {
  name = 'Ventas1787000027000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0027_ventas'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS venta_cotizacion_consecutivo',
    );
    await queryRunner.query('DROP TABLE IF EXISTS venta_documento_linea');
    await queryRunner.query('DROP TABLE IF EXISTS venta_documento');
    await queryRunner.query(
      'ALTER TABLE empresa_resolucion_dian DROP CONSTRAINT IF EXISTS uq_resolucion_id_empresa',
    );
    await queryRunner.query(
      'ALTER TABLE tercero DROP CONSTRAINT IF EXISTS uq_tercero_id_empresa',
    );
  }
}
