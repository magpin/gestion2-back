import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Una línea de compra puede ser un gasto y no solo un producto, y guarda
 * contra qué cuenta se debitó.
 *
 * El DDL vive en `db/migrations/0060_compra_linea_gasto.sql`.
 */
export class CompraLineaGasto1787000060000 implements MigrationInterface {
  name = 'CompraLineaGasto1787000060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0060_compra_linea_gasto'));
  }

  /**
   * Bajarla **falla si ya hay líneas de gasto**, y tiene que ser así: volver
   * a exigir producto obligaría a inventarle uno a un arriendo, o a borrar la
   * línea. Una compra registrada no se reescribe para acomodar un esquema.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS ix_compra_linea_cuenta;
      DROP INDEX IF EXISTS ix_compra_linea_producto;
      CREATE INDEX ix_compra_linea_producto ON compra_documento_linea (producto_id);
      ALTER TABLE compra_documento_linea
        DROP CONSTRAINT IF EXISTS ck_compra_linea_gasto_con_detalle,
        DROP CONSTRAINT IF EXISTS fk_compra_linea_cuenta,
        ALTER COLUMN producto_id SET NOT NULL,
        DROP COLUMN IF EXISTS cuenta_id,
        DROP COLUMN IF EXISTS detalle;
    `);
  }
}
