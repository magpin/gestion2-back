import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Impuestos: calendario tributario (ley), periodicidad de la empresa y sus
 * declaraciones.
 *
 * El DDL vive en `db/migrations/0110_impuestos_declaraciones.sql`.
 */
export class ImpuestosDeclaraciones1787000110000 implements MigrationInterface {
  name = 'ImpuestosDeclaraciones1787000110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0110_impuestos_declaraciones'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE declaracion;
       DROP TABLE empresa_impuesto_config;
       DROP TABLE calendario_tributario;`,
    );
  }
}
