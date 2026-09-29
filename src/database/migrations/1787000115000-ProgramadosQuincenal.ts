import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Pagos programados quincenales y con la cuenta de la que salen.
 *
 * El DDL vive en `db/migrations/0115_programados_quincenal.sql`.
 */
export class ProgramadosQuincenal1787000115000 implements MigrationInterface {
  name = 'ProgramadosQuincenal1787000115000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0115_programados_quincenal'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE pago_programado
         DROP CONSTRAINT fk_programado_cuenta,
         DROP COLUMN cuenta_bancaria_id,
         DROP CONSTRAINT pago_programado_recurrencia_check,
         ADD CONSTRAINT pago_programado_recurrencia_check
           CHECK (recurrencia IN ('UNA_VEZ', 'MENSUAL'));`,
    );
  }
}
