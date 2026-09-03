import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El plan de cuentas de cada empresa y sus centros de costo.
 *
 * Es donde la empresa escoge del catálogo y donde viven sus auxiliares —los
 * bancos con nombre propio, las cajas por punto de venta, los anticipos por
 * empleado—, que el Decreto 2650 no alcanza porque termina en 6 dígitos.
 *
 * `codigo_puc` apunta al ancestro más profundo que sí exista en `cuenta_puc`, y
 * no siempre es una subcuenta: cuando el decreto deja el rango libre (2205, 4135,
 * 1435) el ancla es la cuenta de 4 dígitos.
 *
 * El DDL vive en `db/migrations/0016_empresa_cuenta.sql`.
 */
export class EmpresaCuenta1787000016000 implements MigrationInterface {
  name = 'EmpresaCuenta1787000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0016_empresa_cuenta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS empresa_centro_costo;
DROP TABLE IF EXISTS empresa_cuenta;
DROP FUNCTION IF EXISTS fn_heredar_naturaleza_cuenta();`);
  }
}
