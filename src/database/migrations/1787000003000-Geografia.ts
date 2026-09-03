import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Catalogo DANE de departamentos y municipios. Compartido entre tenants, sin RLS.
 * Los datos se cargan aparte, en un seed.
 *
 * El DDL vive en `db/migrations/0003_geografia.sql`.
 */
export class Geografia1787000003000 implements MigrationInterface {
  name = 'Geografia1787000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0003_geografia'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS municipio;
DROP TABLE IF EXISTS departamento;`);
  }
}
