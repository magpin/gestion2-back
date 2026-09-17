import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La conciliación que propone: extracto importado, grupos de cruce y reglas del extracto.
 *
 * El DDL vive en `db/migrations/0047_conciliacion_propuesta.sql`.
 */
export class ConciliacionPropuesta1787000047000 implements MigrationInterface {
  name = 'ConciliacionPropuesta1787000047000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0047_conciliacion_propuesta'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Vuelve la columna de uno contra uno, llena con los grupos vigentes que
    // lo sean; un grupo de varios contra varios no tiene cómo volver.
    await queryRunner.query(
      `ALTER TABLE extracto_linea
         ADD COLUMN banco_movimiento_id uuid,
         ADD CONSTRAINT fk_extracto_linea_movimiento
           FOREIGN KEY (banco_movimiento_id, empresa_id)
           REFERENCES banco_movimiento (id, empresa_id) ON DELETE RESTRICT,
         ADD CONSTRAINT uq_extracto_linea_movimiento UNIQUE (banco_movimiento_id)`,
    );
    await queryRunner.query(
      `UPDATE extracto_linea el
          SET banco_movimiento_id = pm.banco_movimiento_id
         FROM conciliacion_partida pl
         JOIN conciliacion_partida pm
           ON pm.grupo_id = pl.grupo_id AND pm.vigente AND pm.banco_movimiento_id IS NOT NULL
        WHERE pl.extracto_linea_id = el.id AND pl.vigente
          AND (SELECT count(*) FROM conciliacion_partida p
                WHERE p.grupo_id = pl.grupo_id AND p.vigente) = 2`,
    );
    await queryRunner.query('DROP TABLE IF EXISTS extracto_regla');
    await queryRunner.query('DROP TABLE IF EXISTS conciliacion_partida');
    await queryRunner.query('DROP TABLE IF EXISTS conciliacion_grupo');
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION fn_banco_movimiento_inmutable() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION
             'Un movimiento de banco no se borra. Corregilo con el movimiento contrario.'
             USING ERRCODE = 'check_violation';
         END IF;
         IF ROW(NEW.empresa_id, NEW.cuenta_bancaria_id, NEW.fecha, NEW.tipo,
                NEW.valor, NEW.concepto, NEW.origen_tipo, NEW.origen_id,
                NEW.tercero_id, NEW.saldo_valor, NEW.asiento_id, NEW.creado_por)
            IS DISTINCT FROM
            ROW(OLD.empresa_id, OLD.cuenta_bancaria_id, OLD.fecha, OLD.tipo,
                OLD.valor, OLD.concepto, OLD.origen_tipo, OLD.origen_id,
                OLD.tercero_id, OLD.saldo_valor, OLD.asiento_id, OLD.creado_por) THEN
           RAISE EXCEPTION
             'Un movimiento de banco no se edita: se corrige con el movimiento contrario.'
             USING ERRCODE = 'check_violation';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await queryRunner.query(
      'ALTER TABLE banco_movimiento DROP COLUMN IF EXISTS referencia',
    );
    await queryRunner.query(
      'ALTER TABLE cuenta_bancaria DROP COLUMN IF EXISTS formato_extracto',
    );
    await queryRunner.query(
      `ALTER TABLE extracto_bancario
         DROP CONSTRAINT IF EXISTS uq_extracto_archivo,
         DROP COLUMN IF EXISTS archivo_huella,
         DROP COLUMN IF EXISTS archivo_nombre`,
    );
    await queryRunner.query(
      `ALTER TABLE extracto_linea
         DROP CONSTRAINT IF EXISTS uq_extracto_linea_id_empresa,
         DROP COLUMN IF EXISTS fila_archivo,
         DROP COLUMN IF EXISTS nota,
         DROP COLUMN IF EXISTS origen,
         DROP COLUMN IF EXISTS referencia`,
    );
  }
}
