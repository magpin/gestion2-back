import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Movimiento por concepto (Tesorería), comisión, anticipo y descuento en el
 * recibo de caja, cruces de cartera, y la retención de un anticipo a
 * proveedor en el motor.
 *
 * El DDL vive en `db/migrations/0105_movimiento_concepto_y_cruces.sql`.
 */
export class MovimientoConceptoYCruces1787000105000 implements MigrationInterface {
  name = 'MovimientoConceptoYCruces1787000105000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0105_movimiento_concepto_y_cruces'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE retencion_calculada
         DROP CONSTRAINT retencion_calculada_documento_tipo_check,
         ADD CONSTRAINT retencion_calculada_documento_tipo_check CHECK (documento_tipo IN
           ('COMPRA', 'NOTA_CREDITO_COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA', 'NOTA_CREDITO_VENTA'));
       DROP TABLE cruce_cartera;
       ALTER TABLE recibo_caja_aplicacion
         DROP CONSTRAINT ck_recibo_aplicacion_valor,
         DROP COLUMN asiento_descuento_id,
         DROP COLUMN descuento,
         ADD CONSTRAINT recibo_caja_aplicacion_valor_check CHECK (valor > 0);
       ALTER TABLE recibo_caja
         DROP CONSTRAINT ck_recibo_comision,
         DROP COLUMN anticipo_movimiento_id,
         DROP COLUMN anticipo,
         DROP COLUMN comision_movimiento_id,
         DROP COLUMN comision;
       DROP TABLE movimiento_concepto;`,
    );
  }
}
