import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los cinco catálogos normativos del RUT: tipo de contribuyente (casilla 24),
 * tipo de documento (25), responsabilidades (53), formas asociativas (63) y las
 * responsabilidades del anexo técnico de facturación electrónica.
 *
 * El RUT y la facturación electrónica numeran distinto y no hay correspondencia
 * uno a uno, por eso son dos tablas enlazadas y no una columna extra.
 *
 * El DDL vive en `db/migrations/0013_catalogo_rut.sql`.
 */
export class CatalogoRut1787000013000 implements MigrationInterface {
  name = 'CatalogoRut1787000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0013_catalogo_rut'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS responsabilidad_fiscal_fe;
DROP TABLE IF EXISTS responsabilidad_tributaria;
DROP TABLE IF EXISTS forma_asociativa;
DROP TABLE IF EXISTS tipo_documento_identidad;
DROP TABLE IF EXISTS tipo_contribuyente;`);
  }
}
