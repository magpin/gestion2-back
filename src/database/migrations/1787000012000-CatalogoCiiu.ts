import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Catálogo CIIU Rev. 4 A.C. en sus cuatro niveles: sección, división, grupo, clase.
 *
 * La clase de 4 dígitos es la que va en el RUT y la que referencia
 * `empresa_actividad_economica`. Se carga la versión de la Resolución DIAN
 * 000114 de 2020, no la de 2012: la de 2012 no tiene 7111/7112 ni 8891/8899.
 *
 * El DDL vive en `db/migrations/0012_catalogo_ciiu.sql`.
 */
export class CatalogoCiiu1787000012000 implements MigrationInterface {
  name = 'CatalogoCiiu1787000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0012_catalogo_ciiu'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ciiu_clase;
DROP TABLE IF EXISTS ciiu_grupo;
DROP TABLE IF EXISTS ciiu_division;
DROP TABLE IF EXISTS ciiu_seccion;`);
  }
}
