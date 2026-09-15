import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Facturar sin existencia, cuando la empresa lo permite y quien factura lo
 * confirma: el interruptor `inventario_configuracion.permite_existencia_negativa`
 * y la tabla `venta_faltante`, que anota lo que salió sin estar.
 *
 * El DDL vive en `db/migrations/0037_venta_sin_existencia.sql`.
 */
export class VentaSinExistencia1787000037000 implements MigrationInterface {
  name = 'VentaSinExistencia1787000037000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0037_venta_sin_existencia'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE venta_faltante');
    // El CHECK vuelve, así que antes hay que dejar el kardex sin saldos
    // negativos: si alguno quedó, este revert falla, y es lo correcto —los
    // movimientos son inmutables y no se pueden "corregir" desde acá—.
    await queryRunner.query(
      'DROP TRIGGER tg_movimiento_saldo_negativo ON producto_movimiento',
    );
    await queryRunner.query('DROP FUNCTION fn_saldo_negativo_permitido()');
    await queryRunner.query(
      'ALTER TABLE producto_movimiento ADD CONSTRAINT producto_movimiento_saldo_cantidad_check CHECK (saldo_cantidad >= 0)',
    );
    await queryRunner.query(
      'ALTER TABLE producto_movimiento ADD CONSTRAINT producto_movimiento_saldo_valor_check CHECK (saldo_valor >= 0)',
    );
    await queryRunner.query(
      'ALTER TABLE inventario_configuracion DROP COLUMN permite_existencia_negativa',
    );
  }
}
