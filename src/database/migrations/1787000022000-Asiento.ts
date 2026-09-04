import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El libro.
 *
 * Tres reglas que no las sostiene la aplicacion sino la base: todo asiento
 * cuadra, en periodo cerrado no se escribe, y una cuenta que exige tercero,
 * centro de costo o base gravable los exige. Las tres banderas que 0016 sembro
 * empiezan a rechazar movimientos aca.
 *
 * Van en la base y no en el servicio porque un asiento descuadrado no se corrige
 * editando: se corrige con otro asiento, y para entonces ya esta en el libro.
 *
 * El DDL vive en `db/migrations/0022_asiento.sql`.
 */
export class Asiento1787000022000 implements MigrationInterface {
  name = 'Asiento1787000022000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0022_asiento'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS saldo_cuenta_periodo');
    await queryRunner.query('DROP TABLE IF EXISTS asiento_linea');
    await queryRunner.query('DROP TABLE IF EXISTS asiento');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS fn_linea_ya_comprometida()',
    );
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_linea_inmutable()');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_asiento_inmutable()');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_exigencias_cuenta()');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_candado_periodo()');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_cuadre_asiento()');
  }
}
