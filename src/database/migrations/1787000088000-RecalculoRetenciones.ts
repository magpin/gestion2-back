import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El recálculo de retenciones por cambio de norma (plan motor de retenciones,
 * Fase 6, §6.3): la entrada del motor por documento, las corridas y sus
 * diferencias.
 *
 * El DDL vive en `db/migrations/0088_recalculo_retenciones.sql`.
 */
export class RecalculoRetenciones1787000088000 implements MigrationInterface {
  name = 'RecalculoRetenciones1787000088000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0088_recalculo_retenciones'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Falla si la bitácora ya registró un recálculo: el rastro no se borra.
    await queryRunner.query(`
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN (
          'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
          'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
          'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
          'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
          'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
          'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT', 'CARGAR_PARAMETRO_ICA',
          'CARGAR_AUTORRETENCION'));
      DROP TABLE retencion_recalculo_diferencia;
      DROP TABLE retencion_recalculo;
      DROP TABLE retencion_documento_entrada;
    `);
  }
}
