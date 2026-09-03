-- =============================================================================
-- 0003_geografia — catálogo DANE de departamentos y municipios
-- =============================================================================
-- Catálogo compartido: no lleva empresa_id ni RLS. Lo consultan todos los tenants.
-- La DIAN exige el código de municipio en la factura electrónica, y la tarifa de
-- ICA depende del municipio. Por eso vive en nucleo y no en un módulo posterior.
-- Los datos se cargan aparte, en el seed 0003_geografia.seed.sql.

CREATE TABLE departamento (
  codigo  char(2) PRIMARY KEY CHECK (codigo ~ '^[0-9]{2}$'),
  nombre  text    NOT NULL
);

CREATE TABLE municipio (
  codigo               char(5) PRIMARY KEY CHECK (codigo ~ '^[0-9]{5}$'),
  departamento_codigo  char(2) NOT NULL REFERENCES departamento (codigo),
  nombre               text    NOT NULL
);

CREATE INDEX ix_municipio_departamento ON municipio (departamento_codigo);
CREATE INDEX ix_municipio_nombre ON municipio (fn_normalizar(nombre));

GRANT SELECT ON departamento, municipio TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON departamento, municipio TO gestion_provision;

