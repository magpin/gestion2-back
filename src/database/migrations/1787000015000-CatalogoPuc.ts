import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * PUC del Decreto 2650 de 1993: 2 473 filas en cuatro niveles (clase, grupo,
 * cuenta, subcuenta). Catálogo compartido, ninguna empresa lo edita.
 *
 * La naturaleza débito/crédito viene calculada, no copiada: la base es la clase
 * y encima pesan las cuentas de naturaleza contraria que el decreto marca "(DB)"
 * o "(CR)" en el nombre.
 *
 * Es requisito del módulo de contabilidad: sin estas filas no hay dónde asentar.
 *
 * El DDL vive en `db/migrations/0015_catalogo_puc.sql`.
 */
export class CatalogoPuc1787000015000 implements MigrationInterface {
  name = 'CatalogoPuc1787000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0015_catalogo_puc'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS cuenta_puc;`);
  }
}
