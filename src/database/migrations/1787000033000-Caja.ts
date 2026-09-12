import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Parte A de Caja y Bancos (módulo 7): el maestro (`caja`), su cuenta de
 * diferencia (`caja_configuracion`), el libro (`caja_movimiento`) y el
 * cuadre diario (`caja_arqueo`). Bancos vive en una migración aparte, más
 * adelante (0034 lo tomó la cartera básica del paso 12): son dos cuadres
 * distintos, con reglas de cierre distintas.
 *
 * El DDL vive en `db/migrations/0033_caja.sql`.
 */
export class Caja1787000033000 implements MigrationInterface {
  name = 'Caja1787000033000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0033_caja'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS caja_arqueo');
    await queryRunner.query('DROP TABLE IF EXISTS caja_movimiento');
    await queryRunner.query('DROP TABLE IF EXISTS caja_configuracion');
    await queryRunner.query('DROP TABLE IF EXISTS caja');
  }
}
