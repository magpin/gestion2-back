import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Las decisiones R-D3, R-D12, R-D13 y R-D14 del motor de retenciones, tomadas
 * por Claude con la norma el 26-09-2026 y pendientes de ratificar Yeris.
 *
 * El DDL vive en `db/migrations/0089_decisiones_retenciones.sql`.
 */
export class DecisionesRetenciones1787000089000 implements MigrationInterface {
  name = 'DecisionesRetenciones1787000089000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0089_decisiones_retenciones'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Falla si ya se retuvo con un concepto del exterior o se creó una cuenta
    // con 135517/135518: lo registrado no se borra.
    await queryRunner.query(`
      DELETE FROM retencion_tarifa
       WHERE validado_en = '2026-09-26' AND validado_por LIKE 'Claude%';
      UPDATE retencion_tarifa t SET vigencia_desde = '2026-07-01'
        FROM retencion_concepto_nacional n
       WHERE n.id = t.concepto_id AND t.vigencia_desde = '2025-01-01'
         AND n.codigo IN ('HONORARIOS', 'COMISIONES', 'ARREND_MUEBLES', 'TRANSPORTE_PASAJEROS_AER',
                          'SOFTWARE_LICENCIAS', 'RENDIMIENTOS_FIN', 'COMPRAS_TARJETA',
                          'COMBUSTIBLES', 'LOTERIAS_RIFAS', 'RETEIVA_EXTERIOR');
      DELETE FROM retencion_concepto
       WHERE concepto_nacional_id IN (SELECT id FROM retencion_concepto_nacional WHERE codigo LIKE 'EXT\\_%');
      DELETE FROM retencion_concepto_nacional WHERE codigo LIKE 'EXT\\_%';
      UPDATE retencion_concepto_nacional SET base_es_aiu = false
       WHERE codigo IN ('SERV_TEMPORALES', 'SERV_VIGILANCIA_ASEO');
      DELETE FROM cuenta_puc WHERE codigo IN ('135517', '135518');
    `);
  }
}
