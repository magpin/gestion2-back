-- =============================================================================
-- 0019_sector_economico — el sector deja de ser uno y pasa a ser varios
-- =============================================================================
-- `empresa.sector_economico` guardaba UN valor de cuatro, y el cuarto era
-- 'MIXTO'. Ese valor decía "tengo varios" sin decir cuáles, así que era
-- inservible justo donde más falta hacía: una empresa que comercia y además
-- fabrica no podía expresarlo, y ningún filtro podía apoyarse en él.
--
-- Ahora son N sectores de tres. Misma forma que `tercero_responsabilidad_fiscal`:
-- pocos valores de un catálogo corto, sin vigencia, con la empresa como dueña.
--
-- SIN VIGENCIA, a diferencia del régimen tributario o la actividad económica. El
-- sector no es un hecho fiscal: la DIAN nunca va a preguntar cuál era el sector
-- de la empresa en una fecha pasada. Lo que sí le importa —la actividad CIIU—
-- vive en `empresa_actividad_economica` y ahí sí lleva fecha_inicio y fecha_fin.

CREATE TABLE empresa_sector (
  empresa_id uuid        NOT NULL REFERENCES empresa (id),
  sector     text        NOT NULL CHECK (sector IN ('COMERCIO', 'SERVICIOS', 'MANUFACTURA')),
  creado_en  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (empresa_id, sector)
);

COMMENT ON TABLE empresa_sector IS
  'A que se dedica la empresa, en grueso. Complementa las actividades CIIU: el sector marcado puede agregar cuentas al filtro del PUC, nunca quitar las que respalda el RUT.';

CREATE INDEX ix_empresa_sector_empresa ON empresa_sector (empresa_id);

ALTER TABLE empresa_sector ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_sector FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_empresa_sector_aislada ON empresa_sector
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT ON empresa_sector TO gestion_app, gestion_provision;
-- Excepción al "nada se borra": el sector es un atributo, no un hecho contable.
-- Desmarcarlo no deja huérfanos ni huecos, y guardarlo desmarcado no le sirve a
-- nadie. Se quita y se vuelve a poner.
GRANT DELETE ON empresa_sector TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- Migrar lo que hay
-- -----------------------------------------------------------------------------
-- 'MIXTO' no se traduce: significaba "varios" sin decir cuáles, y adivinar sería
-- inventarle sectores a una empresa. Esas quedan sin ninguno y el usuario marca
-- los suyos — que es exactamente lo que el valor viejo nunca dejó registrar.
INSERT INTO empresa_sector (empresa_id, sector)
SELECT id, sector_economico
  FROM empresa
 WHERE sector_economico IN ('COMERCIO', 'SERVICIOS', 'MANUFACTURA');

-- -----------------------------------------------------------------------------
-- Y se va la columna
-- -----------------------------------------------------------------------------
-- Dejarla muerta sería conservar la ambigüedad que esta migración vino a quitar:
-- dos lugares donde leer el sector, uno de ellos con un valor que no significa
-- nada. El dato ya está arriba.
ALTER TABLE empresa DROP COLUMN sector_economico;
