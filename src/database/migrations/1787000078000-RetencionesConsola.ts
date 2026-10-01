import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Consola de plataforma: la bitácora admite las cargas de la ley de
 * retenciones (plan motor de retenciones, Fase 0, §0.8).
 *
 * El DDL vive en `db/migrations/0078_retenciones_consola.sql`.
 */
export class RetencionesConsola1787000078000 implements MigrationInterface {
  name = 'RetencionesConsola1787000078000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0078_retenciones_consola'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM plataforma_bitacora WHERE accion IN ('CARGAR_TARIFA_RETENCION', 'CARGAR_UVT');
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN (
          'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
          'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
          'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
          'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
          'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN'));
    `);
  }
}
