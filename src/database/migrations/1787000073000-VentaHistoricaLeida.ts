import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Que María lea las facturas de venta del sistema anterior.
 *
 * El DDL vive en `db/migrations/0073_venta_historica_leida.sql`.
 */
export class VentaHistoricaLeida1787000073000 implements MigrationInterface {
  name = 'VentaHistoricaLeida1787000073000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0073_venta_historica_leida'));
  }

  /** Bajarla falla si ya hay ventas anteriores leídas: el CHECK viejo no las admite. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX uq_documento_leido_en_curso;
      CREATE UNIQUE INDEX uq_documento_leido_en_curso
        ON documento_leido (empresa_id, tipo)
        WHERE estado IN ('EN_COLA', 'LEYENDO') AND tipo NOT IN ('FACTURA_COMPRA', 'PEDIDO_VENTA');
      ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_tipo_check;
      ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_tipo_check
        CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN', 'FACTURA_COMPRA', 'PEDIDO_VENTA'));
    `);
  }
}
