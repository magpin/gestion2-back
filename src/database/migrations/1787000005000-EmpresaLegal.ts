import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Condiciones legales con vigencia (actividad CIIU, regimen tributario,
 * representante, matricula) y la configuracion contable 1:1.
 *
 * El DDL vive en `db/migrations/0005_empresa_legal.sql`.
 */
export class EmpresaLegal1787000005000 implements MigrationInterface {
  name = 'EmpresaLegal1787000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0005_empresa_legal'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS empresa_configuracion_contable;
DROP TABLE IF EXISTS empresa_matricula_mercantil;
DROP TABLE IF EXISTS empresa_representante;
DROP TABLE IF EXISTS empresa_regimen_tributario;
DROP TABLE IF EXISTS empresa_actividad_economica;`);
  }
}
