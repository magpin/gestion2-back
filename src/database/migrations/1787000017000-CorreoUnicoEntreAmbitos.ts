import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * Un correo no puede estar en `usuario` y en `plataforma_admin` a la vez.
 *
 * Hace falta desde que el login es uno solo: el correo decide contra qué almacén
 * de credenciales se autentica, y un correo repetido dejaría al usuario cliente
 * sin poder entrar nunca. Cada tabla ya tenía su UNIQUE, pero un UNIQUE no cruza
 * tablas — un trigger sí.
 *
 * El DDL vive en `db/migrations/0017_correo_unico_entre_ambitos.sql`.
 */
export class CorreoUnicoEntreAmbitos1787000017000 implements MigrationInterface {
  name = 'CorreoUnicoEntreAmbitos1787000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0017_correo_unico_entre_ambitos'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS tg_plataforma_admin_correo_libre ON plataforma_admin;
DROP TRIGGER IF EXISTS tg_usuario_correo_libre ON usuario;
DROP FUNCTION IF EXISTS fn_correo_libre_en_el_otro_ambito();`);
  }
}
