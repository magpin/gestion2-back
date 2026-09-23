import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Que María lea el pedido de un cliente y arme la factura de venta.
 *
 * El DDL vive en `db/migrations/0064_pedido_venta_leido.sql`.
 */
export class PedidoVentaLeido1787000064000 implements MigrationInterface {
  name = 'PedidoVentaLeido1787000064000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0064_pedido_venta_leido'));
  }

  /** Bajarla falla si ya hay pedidos leídos: el CHECK viejo no los admite. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS uq_venta_documento_leido;
      ALTER TABLE venta_documento DROP COLUMN IF EXISTS documento_leido_id;
      DROP INDEX uq_documento_leido_en_curso;
      CREATE UNIQUE INDEX uq_documento_leido_en_curso
        ON documento_leido (empresa_id, tipo)
        WHERE estado IN ('EN_COLA', 'LEYENDO') AND tipo <> 'FACTURA_COMPRA';
      ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_tipo_check;
      ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_tipo_check
        CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN', 'FACTURA_COMPRA'));
    `);
  }
}
