import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Ocho cuentas del Decreto 2650 que la base Access de origen nunca cargó, más
 * las subcuentas fijas de las que las tienen enumeradas.
 *
 * La que fuerza esta migración es `2367 IMPUESTO A LAS VENTAS RETENIDO`: sin
 * ella, una empresa agente de retención de IVA no tiene dónde registrar lo que
 * retiene, y la sugerencia de plan de cuentas no puede proponérsela.
 *
 * El DDL vive en `db/migrations/0018_puc_cuentas_faltantes.sql`.
 */
export class PucCuentasFaltantes1787000018000 implements MigrationInterface {
  name = 'PucCuentasFaltantes1787000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0018_puc_cuentas_faltantes'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM cuenta_puc WHERE codigo IN
      ('292005','292010','292015','292505','292510','292515','322510','421805','421810','531305','531310');
DELETE FROM cuenta_puc WHERE codigo IN
      ('2357','2367','2476','2920','2925','3225','4218','5313');`);
  }
}
