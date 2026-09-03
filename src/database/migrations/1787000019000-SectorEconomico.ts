import type { MigrationInterface, QueryRunner } from 'typeorm';

import { leerSql } from '../leer-sql';

/**
 * El sector económico deja de ser uno y pasa a ser varios.
 *
 * El valor 'MIXTO' decía "tengo varios" sin decir cuáles, así que no servía para
 * filtrar nada — y era justo el caso de la empresa que comercia y además fabrica.
 *
 * El `down()` reconstruye la columna y devuelve un solo sector por empresa. No es
 * simétrico y no puede serlo: una empresa con dos sectores no cabe en un campo de
 * un valor, así que al revertir se queda con el primero en orden alfabético y el
 * resto se pierde. Revertir esta migración pierde información a propósito.
 *
 * El DDL vive en `db/migrations/0019_sector_economico.sql`.
 */
export class SectorEconomico1787000019000 implements MigrationInterface {
  name = 'SectorEconomico1787000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(leerSql('0019_sector_economico'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE empresa ADD COLUMN sector_economico text;

UPDATE empresa e SET sector_economico = (
  SELECT s.sector FROM empresa_sector s WHERE s.empresa_id = e.id ORDER BY s.sector LIMIT 1
);

-- Las que no tenian ninguno vuelven como 'MIXTO', que es lo mas honesto que
-- permite el modelo viejo: no sabemos cual era.
UPDATE empresa SET sector_economico = 'MIXTO' WHERE sector_economico IS NULL;

ALTER TABLE empresa ALTER COLUMN sector_economico SET NOT NULL;
ALTER TABLE empresa ADD CONSTRAINT empresa_sector_economico_check
  CHECK (sector_economico IN ('COMERCIO','SERVICIOS','MANUFACTURA','MIXTO'));

DROP TABLE IF EXISTS empresa_sector;`);
  }
}
