import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Arqueo por concepto (sobrante, faltante cobrable, faltante asumido),
 * responsable de caja y terceros empleados.
 *
 * El DDL vive en `db/migrations/0069_arqueo_por_concepto.sql`.
 */
export class ArqueoPorConcepto1787000069000 implements MigrationInterface {
  name = 'ArqueoPorConcepto1787000069000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0069_arqueo_por_concepto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE caja_arqueo
        DROP CONSTRAINT ck_arqueo_tratamiento,
        DROP COLUMN responsable_tercero_id,
        DROP COLUMN tratamiento_faltante;
      ALTER TABLE caja DROP COLUMN responsable_tercero_id;
      ALTER TABLE caja_configuracion ADD COLUMN cuenta_diferencia_id uuid;
      UPDATE caja_configuracion SET cuenta_diferencia_id = cuenta_faltante_asumido_id;
      ALTER TABLE caja_configuracion
        ADD CONSTRAINT fk_caja_config_cuenta
          FOREIGN KEY (cuenta_diferencia_id, empresa_id)
          REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
        DROP COLUMN cuenta_sobrante_id,
        DROP COLUMN cuenta_faltante_cobrable_id,
        DROP COLUMN cuenta_faltante_asumido_id;
      DROP INDEX ix_tercero_empleado;
      ALTER TABLE tercero DROP CONSTRAINT ck_tercero_rol;
      ALTER TABLE tercero ADD CONSTRAINT ck_tercero_rol CHECK (es_cliente OR es_proveedor);
      ALTER TABLE tercero DROP COLUMN es_empleado;
    `);
  }
}
