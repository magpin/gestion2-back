import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * La consola de plataforma, fase 2: precios, cargos y pagos, la mora
 * automática, las pausas de la IA, los anuncios y los intentos de ingreso.
 *
 * El DDL vive en `db/migrations/0056_plataforma_cobros.sql`.
 */
export class PlataformaCobros1787000056000 implements MigrationInterface {
  name = 'PlataformaCobros1787000056000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0056_plataforma_cobros'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Bajarla pierde los cobros registrados, y exige que la bitácora no tenga
    // filas del sistema ni acciones nuevas.
    await queryRunner.query(`
      DROP TABLE IF EXISTS login_fallido;
      DROP TABLE IF EXISTS anuncio;
      DROP TABLE IF EXISTS ia_pausa;
      DROP TABLE IF EXISTS suscripcion_pago;
      DROP TABLE IF EXISTS suscripcion_cargo;
      ALTER TABLE tenant
        DROP COLUMN IF EXISTS cobro_desde,
        DROP COLUMN IF EXISTS dia_corte,
        DROP COLUMN IF EXISTS precio_pactado;
      ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
      ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
        CHECK (accion IN ('CREAR_CUENTA','CREAR_EMPRESA','CREAR_USUARIO','CAMBIAR_ESTADO',
          'CAMBIAR_PLAN','AJUSTAR_CUPOS','RENOMBRAR_CUENTA','RESTABLECER_PASSWORD',
          'DESACTIVAR_USUARIO','REACTIVAR_USUARIO','EDITAR_PLAN'));
      ALTER TABLE plataforma_bitacora ALTER COLUMN admin_id SET NOT NULL;
      UPDATE plan_catalogo SET precio_mensual = NULL, tope_ia_usd = NULL, al_llegar_tope = NULL;
    `);
  }
}
