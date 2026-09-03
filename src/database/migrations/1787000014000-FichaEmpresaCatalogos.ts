import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Amarra la ficha de empresa a los catálogos de 0012 y 0013.
 *
 * Deja de haber códigos sueltos validados con un CHECK escrito a mano: el CIIU,
 * los tipos de documento y las responsabilidades fiscales pasan a ser claves
 * foráneas. Agrega la forma asociativa (S.A.S. y compañía), que faltaba, y la
 * casilla 53 del RUT de la empresa con vigencia.
 *
 * El `down()` devuelve los CHECK originales para no dejar las tablas sin ninguna
 * validación si se revierte.
 *
 * El DDL vive en `db/migrations/0014_ficha_empresa_catalogos.sql`.
 */
export class FichaEmpresaCatalogos1787000014000 implements MigrationInterface {
  name = 'FichaEmpresaCatalogos1787000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0014_ficha_empresa_catalogos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS empresa_responsabilidad_rut;

ALTER TABLE tercero_responsabilidad_fiscal DROP CONSTRAINT IF EXISTS fk_responsabilidad_fe;
ALTER TABLE tercero_responsabilidad_fiscal
  ADD CONSTRAINT tercero_responsabilidad_fiscal_codigo_check
  CHECK (codigo ~ '^[A-Z]-[0-9]{2}(-[A-Z]{2})?$');

ALTER TABLE empresa_representante DROP CONSTRAINT IF EXISTS fk_representante_tipo_documento;
ALTER TABLE empresa_representante
  ADD CONSTRAINT empresa_representante_tipo_documento_check
  CHECK (tipo_documento IN ('CC', 'CE', 'PA', 'NIT', 'PEP'));

ALTER TABLE tercero DROP CONSTRAINT IF EXISTS fk_tercero_tipo_documento;
ALTER TABLE tercero
  ADD CONSTRAINT tercero_tipo_documento_check
  CHECK (tipo_documento IN ('CC', 'CE', 'NIT', 'TI', 'RC', 'PA', 'PEP', 'PPT',
                            'NIT_EXTRANJERO', 'NUIP', 'DOC_EXTRANJERO'));

ALTER TABLE empresa DROP CONSTRAINT IF EXISTS ck_empresa_forma_asociativa;
ALTER TABLE empresa DROP COLUMN IF EXISTS forma_asociativa_codigo;

ALTER TABLE empresa_actividad_economica DROP CONSTRAINT IF EXISTS fk_actividad_ciiu;
ALTER TABLE empresa_actividad_economica ALTER COLUMN codigo_ciiu TYPE varchar(6);
ALTER TABLE empresa_actividad_economica
  ADD CONSTRAINT empresa_actividad_economica_codigo_ciiu_check
  CHECK (codigo_ciiu ~ '^[0-9]{4}$');`);
  }
}
