import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La unidad contable y sus sedes. El digito de verificacion del NIT se verifica
 * con un CHECK, no se captura a ciegas.
 *
 * El DDL vive en `db/migrations/0004_empresa.sql`.
 */
export class Empresa1787000004000 implements MigrationInterface {
  name = 'Empresa1787000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0004_empresa'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS empresa_sede;
DROP TABLE IF EXISTS empresa;`);
  }
}
