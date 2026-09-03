import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El catálogo DANE con datos: 33 departamentos y 1.122 municipios.
 *
 * Viaja como migración y no como seed opcional porque `empresa_sede` y `tercero`
 * tienen FK contra `municipio`: una base recién creada sin estas filas no puede
 * guardar ni una sede.
 *
 * El DDL vive en `db/migrations/0010_geografia_datos.sql`, y se regenera con
 * `node scripts/generar-seed-geografia.js`.
 */
export class GeografiaDatos1787000010000 implements MigrationInterface {
  name = 'GeografiaDatos1787000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0010_geografia_datos'));
  }

  /**
   * Vaciar el catálogo falla si alguna sede o tercero apunta a un municipio, y
   * eso es lo correcto: el `down()` no puede dejar filas huérfanas.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM municipio;
DELETE FROM departamento;`);
  }
}
