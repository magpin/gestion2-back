import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Paso 12 de Caja y Bancos (`docs/planes/caja-cartera.md`): `monto_pagado`
 * en `venta_documento` y `compra_documento` — el hueco que apareció al ir
 * a conectar "Cobrar/Pagar en efectivo" a `TesoreriaApi` y descubrir que
 * ninguno de los dos documentos sabía cuánto le quedaba pendiente.
 *
 * El DDL vive en `db/migrations/0034_cartera.sql`.
 */
export class Cartera1787000034000 implements MigrationInterface {
  name = 'Cartera1787000034000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0034_cartera'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE compra_documento DROP CONSTRAINT IF EXISTS ck_compra_monto_pagado',
    );
    await queryRunner.query(
      'ALTER TABLE compra_documento DROP COLUMN IF EXISTS monto_pagado',
    );
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP CONSTRAINT IF EXISTS ck_venta_monto_pagado',
    );
    await queryRunner.query(
      'ALTER TABLE venta_documento DROP COLUMN IF EXISTS monto_pagado',
    );
  }
}
