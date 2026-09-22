import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Lo que necesita la consola de plataforma: la bitácora con una acción por
 * cambio, el catálogo de planes y un acceso por usuario y día.
 *
 * El DDL vive en `db/migrations/0055_plataforma_consola.sql`.
 */
export class PlataformaConsola1787000055000 implements MigrationInterface {
  name = 'PlataformaConsola1787000055000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0055_plataforma_consola'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las filas de la bitácora con acciones nuevas no caben en el CHECK viejo:
    // bajar esta migración exige que no haya ninguna.
    await queryRunner.query(`
      DROP TABLE IF EXISTS usuario_acceso_dia;
      DROP TABLE IF EXISTS plan_catalogo;
      DROP INDEX IF EXISTS ix_bitacora_ocurrido;
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN ('CREAR_CUENTA','CREAR_EMPRESA','CREAR_USUARIO','CAMBIAR_ESTADO','CAMBIAR_PLAN'));
    `);
  }
}
