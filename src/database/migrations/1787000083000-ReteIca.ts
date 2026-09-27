import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * ReteICA en varios municipios: la ley municipal, el ICA de cada proveedor por
 * municipio y el acumulado del período (plan motor de retenciones, Fase 3).
 *
 * El DDL vive en `db/migrations/0083_reteica.sql`.
 */
export class ReteIca1787000083000 implements MigrationInterface {
  name = 'ReteIca1787000083000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0083_reteica'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM plataforma_bitacora WHERE accion = 'CARGAR_PARAMETRO_ICA';
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN (
          'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
          'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
          'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
          'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
          'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
          'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT'));
      DROP INDEX ux_compra_retencion_concepto_municipio;
      ALTER TABLE compra_retencion DROP COLUMN municipio_codigo;
      ALTER TABLE compra_retencion ADD CONSTRAINT uq_compra_retencion_concepto
        UNIQUE (compra_documento_id, concepto);
      DROP TABLE ica_acumulado_periodo;
      DROP TABLE tercero_perfil_ica;
      DROP TABLE ica_matriz_agente;
      DROP TABLE ica_tarifa;
      DROP TABLE ica_parametro;
    `);
  }
}
