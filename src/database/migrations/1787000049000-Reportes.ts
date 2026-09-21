import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Reportes: quién sacó cada uno y cuándo, y los que alguien armó y guardó.
 *
 * El DDL vive en `db/migrations/0049_reportes.sql`.
 */
export class Reportes1787000049000 implements MigrationInterface {
  name = 'Reportes1787000049000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0049_reportes'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Primero la de corridas, que apunta a la de guardados. Ninguna otra tabla
    // las referencia: bajarlas no toca un solo dato contable. Lo que se pierde
    // es el rastro de quién sacó qué, y los reportes armados —que son
    // definiciones y se pueden volver a armar—.
    await queryRunner.query('DROP TABLE IF EXISTS reporte_corrida');
    await queryRunner.query('DROP TABLE IF EXISTS reporte_guardado');
  }
}
