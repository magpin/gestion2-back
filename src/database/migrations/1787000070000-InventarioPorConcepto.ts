import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Inventario sin configuración: cuentas por concepto, «vender sin existencia»
 * como hecho operativo y el tratamiento de un faltante de inventario.
 *
 * El DDL vive en `db/migrations/0070_inventario_por_concepto.sql`.
 */
export class InventarioPorConcepto1787000070000 implements MigrationInterface {
  name = 'InventarioPorConcepto1787000070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0070_inventario_por_concepto'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE producto_movimiento
        DROP CONSTRAINT ck_mov_tratamiento,
        DROP COLUMN responsable_tercero_id,
        DROP COLUMN tratamiento_faltante;

      ALTER TABLE inventario_configuracion
        ADD COLUMN permite_existencia_negativa boolean NOT NULL DEFAULT false,
        ADD COLUMN cuenta_ajuste_id uuid;
      UPDATE inventario_configuracion ic
         SET permite_existencia_negativa = EXISTS (
               SELECT 1 FROM empresa_hecho_operativo h
                WHERE h.empresa_id = ic.empresa_id AND h.hecho = 'VENDE_SIN_EXISTENCIA'),
             cuenta_ajuste_id = cuenta_faltante_asumido_id;
      ALTER TABLE inventario_configuracion
        ADD CONSTRAINT fk_config_cuenta_ajuste
          FOREIGN KEY (cuenta_ajuste_id, empresa_id)
          REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
        DROP COLUMN cuenta_inventario_id,
        DROP COLUMN cuenta_ingreso_id,
        DROP COLUMN cuenta_costo_venta_id,
        DROP COLUMN cuenta_sobrante_id,
        DROP COLUMN cuenta_faltante_asumido_id,
        DROP COLUMN cuenta_faltante_cobrable_id;

      CREATE OR REPLACE FUNCTION fn_saldo_negativo_permitido() RETURNS trigger AS $$
      DECLARE
        v_permite boolean;
      BEGIN
        IF NEW.saldo_cantidad >= 0 THEN
          RETURN NEW;
        END IF;
        SELECT coalesce(permite_existencia_negativa, false) INTO v_permite
          FROM inventario_configuracion WHERE empresa_id = NEW.empresa_id;
        IF coalesce(v_permite, false) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'El movimiento deja la existencia del producto % en %, y esta empresa no permite existencia negativa.',
          NEW.producto_id, NEW.saldo_cantidad;
      END;
      $$ LANGUAGE plpgsql;

      DELETE FROM empresa_hecho_operativo WHERE hecho = 'VENDE_SIN_EXISTENCIA';
      ALTER TABLE empresa_hecho_operativo DROP CONSTRAINT empresa_hecho_operativo_hecho_check;
      ALTER TABLE empresa_hecho_operativo ADD CONSTRAINT empresa_hecho_operativo_hecho_check
        CHECK (hecho IN ('TIENE_EMPLEADOS','TIENE_ACTIVOS_FIJOS','TIENE_CREDITO_BANCARIO','MANEJA_CAJA_MENOR'));
    `);
  }
}
