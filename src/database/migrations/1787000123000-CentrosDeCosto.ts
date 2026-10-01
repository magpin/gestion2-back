import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Centros de costo, fase 1: agrupación, sede, tipo y por defecto; llaves
 * compuestas con la empresa; el centro en los documentos y por usuario.
 *
 * El DDL vive en `db/migrations/0123_centros_de_costo.sql`.
 */
export class CentrosDeCosto1787000123000 implements MigrationInterface {
  name = 'CentrosDeCosto1787000123000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0123_centros_de_costo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // fn_exigencias_cuenta vuelve a la de 0022: la nueva lee `padre_id`,
    // que se borra abajo, y sin esto ningún asiento podría registrarse.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_exigencias_cuenta() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        c record;
      BEGIN
        SELECT codigo, nombre, es_auxiliar, activa,
               exige_tercero, exige_centro_costo, exige_base_gravable
          INTO c
          FROM empresa_cuenta WHERE id = NEW.cuenta_id;
        IF NOT c.es_auxiliar THEN
          RAISE EXCEPTION
            'La cuenta % (%) agrupa y no recibe movimientos. Usa una de sus auxiliares.',
            c.codigo, c.nombre USING ERRCODE = 'check_violation';
        END IF;
        IF NOT c.activa THEN
          RAISE EXCEPTION
            'La cuenta % (%) esta desactivada y no acepta movimientos nuevos.',
            c.codigo, c.nombre USING ERRCODE = 'check_violation';
        END IF;
        IF c.exige_tercero AND NEW.tercero_id IS NULL THEN
          RAISE EXCEPTION
            'La cuenta % (%) exige tercero: sin el no se sabe a quien se le debe ni quien debe.',
            c.codigo, c.nombre USING ERRCODE = 'not_null_violation';
        END IF;
        IF c.exige_centro_costo AND NEW.centro_costo_id IS NULL THEN
          RAISE EXCEPTION
            'La cuenta % (%) exige centro de costo: sin el el gasto no se puede repartir.',
            c.codigo, c.nombre USING ERRCODE = 'not_null_violation';
        END IF;
        IF c.exige_base_gravable AND NEW.base_gravable IS NULL THEN
          RAISE EXCEPTION
            'La cuenta % (%) exige base gravable: el medio magnetico pide la base y el impuesto por separado.',
            c.codigo, c.nombre USING ERRCODE = 'not_null_violation';
        END IF;
        RETURN NEW;
      END;
      $$;`);
    await queryRunner.query(
      `DROP TABLE usuario_empresa_centro;
       ALTER TABLE compra_documento_linea DROP COLUMN reparto_id;
       DROP TABLE centro_costo_reparto_linea;
       DROP TABLE centro_costo_reparto;
       ALTER TABLE extracto_regla DROP COLUMN centro_costo_id;
       ALTER TABLE movimiento_concepto_linea DROP COLUMN centro_costo_id;
       ALTER TABLE movimiento_concepto DROP COLUMN centro_costo_id;
       ALTER TABLE compra_documento_linea DROP COLUMN centro_costo_id;
       ALTER TABLE compra_documento DROP COLUMN centro_costo_id;
       ALTER TABLE venta_documento DROP COLUMN centro_costo_id;
       ALTER TABLE asiento_linea DROP CONSTRAINT fk_linea_centro_costo;
       ALTER TABLE asiento_linea ADD CONSTRAINT fk_linea_centro_costo
         FOREIGN KEY (centro_costo_id) REFERENCES empresa_centro_costo (id) ON DELETE RESTRICT;
       DROP TRIGGER tg_cuenta_nueva_exige_centro ON empresa_cuenta;
       DROP FUNCTION fn_cuenta_nueva_exige_centro();
       DROP TRIGGER tg_centro_costo_niveles ON empresa_centro_costo;
       DROP FUNCTION fn_centro_costo_niveles();
       ALTER TABLE empresa_centro_costo
         DROP COLUMN padre_id, DROP COLUMN sede_id, DROP COLUMN tipo,
         DROP COLUMN es_por_defecto,
         DROP CONSTRAINT uq_centro_costo_id_empresa;`,
    );
  }
}
