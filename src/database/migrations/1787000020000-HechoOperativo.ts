import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los hechos de la operación que ningún documento declara.
 *
 * El RUT dice si la empresa cobra IVA y la CIIU de qué son sus ingresos, pero
 * ningún papel dice si tiene empleados o crédito bancario. Sin ese dato el plan
 * de cuentas no puede decidir entre proponer las prestaciones sociales o no
 * proponer ninguna, y adivinar es peor que preguntar.
 *
 * El `down()` borra la tabla entera. Acá sí es simétrico: son respuestas a
 * cuatro preguntas, no hechos contables, y las cuentas que ya justificaron
 * viven en `empresa_cuenta` y no se van con ellas.
 *
 * El DDL vive en `db/migrations/0020_hecho_operativo.sql`.
 */
export class HechoOperativo1787000020000 implements MigrationInterface {
  name = 'HechoOperativo1787000020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0020_hecho_operativo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS empresa_hecho_operativo');
  }
}
