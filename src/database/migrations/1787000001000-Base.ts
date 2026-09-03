import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Extensiones, funciones comunes (marca de actualizacion, contexto de sesion,
 * digito de verificacion del NIT) y los dos roles de conexion.
 *
 * El DDL vive en `db/migrations/0001_base.sql`.
 *
 * Las extensiones (citext, unaccent, pgcrypto) NO se eliminan: pueden estar
 * en uso por otros objetos y volver a crearlas es gratis.
 */
export class Base1787000001000 implements MigrationInterface {
  name = 'Base1787000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0001_base'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_normalizar(text);
DROP FUNCTION IF EXISTS fn_dv_nit(text);
DROP FUNCTION IF EXISTS app_empresa_id();
DROP FUNCTION IF EXISTS app_tenant_id();
DROP FUNCTION IF EXISTS fn_marcar_actualizado();
REVOKE USAGE ON SCHEMA public FROM gestion_app, gestion_provision;
DROP ROLE IF EXISTS gestion_app;
DROP ROLE IF EXISTS gestion_provision;`);
  }
}
