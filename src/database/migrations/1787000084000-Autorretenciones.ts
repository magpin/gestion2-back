import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Autorretenciones (especial por CIIU y venta al SIMPLE) y el aviso de lo que
 * retiene el cliente (plan motor de retenciones, Fase 4).
 *
 * El DDL vive en `db/migrations/0084_autorretenciones.sql`.
 */
export class Autorretenciones1787000084000 implements MigrationInterface {
  name = 'Autorretenciones1787000084000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0084_autorretenciones'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM plataforma_bitacora WHERE accion = 'CARGAR_AUTORRETENCION';
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN (
          'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
          'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
          'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
          'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
          'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
          'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT', 'CARGAR_PARAMETRO_ICA'));
      ALTER TABLE venta_documento DROP COLUMN retencion_aviso;
      DELETE FROM retencion_concepto
       WHERE concepto_nacional_id = (SELECT id FROM retencion_concepto_nacional
                                      WHERE codigo = 'AUTORRETENCION_ESPECIAL');
      DELETE FROM retencion_concepto_nacional WHERE codigo = 'AUTORRETENCION_ESPECIAL';
      DROP TABLE retencion_autorretencion_ciiu;
    `);
  }
}
