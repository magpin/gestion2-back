import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El perfil tributario del tercero se escribe directo, con su fecha (plan motor
 * de retenciones, Fase 1, §1.4).
 *
 * El DDL vive en `db/migrations/0081_perfil_tercero_directo.sql`. El `down`
 * vuelve a la función de la 0075 (sin la marca de sesión).
 */
export class PerfilTerceroDirecto1787000081000 implements MigrationInterface {
  name = 'PerfilTerceroDirecto1787000081000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0081_perfil_tercero_directo'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const sql = leerSql('0081_perfil_tercero_directo').replace(
      / {2}IF TG_OP = 'UPDATE' AND current_setting\('app\.perfil_directo', true\) = 'on' THEN\s+RETURN NEW;\s+END IF;\s+/,
      '',
    );
    await queryRunner.query(sql);
  }
}
