import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Los `GRANT` que les faltaban a las tablas de `0041` y `0043`, y los permisos
 * por omisión para que olvidarse no vuelva a romper una pantalla.
 *
 * El DDL vive en `db/migrations/0044_permisos_tablas_nuevas.sql`.
 */
export class PermisosTablasNuevas1787000044000 implements MigrationInterface {
  name = 'PermisosTablasNuevas1787000044000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0044_permisos_tablas_nuevas'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM gestion_app, gestion_provision',
    );
    await queryRunner.query(
      'REVOKE SELECT, INSERT, UPDATE ON producto_categoria, retencion_concepto, venta_retencion, uvt FROM gestion_app, gestion_provision',
    );
  }
}
