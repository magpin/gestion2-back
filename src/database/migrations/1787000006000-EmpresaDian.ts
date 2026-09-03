import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Resoluciones de numeracion y credenciales de facturacion electronica. Es la
 * autorizacion para emitir; la transmision del XML es del modulo `dian`.
 *
 * El DDL vive en `db/migrations/0006_empresa_dian.sql`.
 */
export class EmpresaDian1787000006000 implements MigrationInterface {
  name = 'EmpresaDian1787000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0006_empresa_dian'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS empresa_credencial_dian;
DROP TABLE IF EXISTS empresa_resolucion_dian;`);
  }
}
