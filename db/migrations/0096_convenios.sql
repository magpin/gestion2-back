-- =============================================================================
-- 0096 — Tarifa de convenio (CDI) en pagos al exterior
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.15).
--
-- Un convenio para evitar la doble imposición baja la retención de intereses
-- y regalías a un residente del otro país, **si prueba su residencia fiscal**
-- con el certificado de la autoridad de su país (Oficios DIAN 67157 de 2014 y
-- 10760 de 2013). El motor la propone cuando hay certificado vigente a la
-- fecha y una persona la aplica: nunca sola.
--
-- Semilla: solo lo confirmado el 26-09-2026 (PwC Tax Summaries y página de
-- convenios de la DIAN), la tarifa general del artículo de intereses y del de
-- regalías. Los servicios técnicos no se cargan: en varios convenios no son
-- regalías y tributan solo con establecimiento permanente, y eso lo decide
-- el contador. La Decisión 578 de la CAN no baja la tarifa: no se carga.
-- Firmado «Claude … (pendiente de ratificar Yeris)».

CREATE TABLE cdi_tarifa (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  pais_codigo     char(2)      NOT NULL CHECK (pais_codigo ~ '^[A-Z]{2}$'),
  pais_nombre     text         NOT NULL,
  tipo_renta      text         NOT NULL CHECK (tipo_renta IN ('INTERESES', 'REGALIAS')),
  tarifa          numeric(6,4) NOT NULL CHECK (tarifa >= 0 AND tarifa < 1),
  vigencia_desde  date         NOT NULL,
  vigencia_hasta  date,
  ley             text         NOT NULL,
  validado_por    text         NOT NULL,
  validado_en     date         NOT NULL,
  CONSTRAINT ex_cdi_sin_solape EXCLUDE USING gist (
    pais_codigo WITH =,
    tipo_renta WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);
GRANT SELECT ON cdi_tarifa TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON cdi_tarifa TO gestion_provision;

INSERT INTO cdi_tarifa (pais_codigo, pais_nombre, tipo_renta, tarifa, vigencia_desde, ley, validado_por, validado_en)
SELECT pais, nombre, tipo, tarifa, desde::date, ley,
       'Claude, con el texto del convenio y PwC Tax Summaries (pendiente de ratificar Yeris)', '2026-09-26'
  FROM (VALUES
    ('ES', 'España',       'INTERESES', 0.10, '2008-10-23', 'Ley 1082 de 2006'),
    ('ES', 'España',       'REGALIAS',  0.10, '2008-10-23', 'Ley 1082 de 2006'),
    ('CL', 'Chile',        'INTERESES', 0.15, '2009-12-22', 'Ley 1261 de 2008'),
    ('CL', 'Chile',        'REGALIAS',  0.10, '2009-12-22', 'Ley 1261 de 2008'),
    ('CH', 'Suiza',        'INTERESES', 0.10, '2012-01-01', 'Ley 1344 de 2009'),
    ('CH', 'Suiza',        'REGALIAS',  0.10, '2012-01-01', 'Ley 1344 de 2009'),
    ('CA', 'Canadá',       'INTERESES', 0.10, '2012-06-12', 'Ley 1459 de 2011'),
    ('CA', 'Canadá',       'REGALIAS',  0.10, '2012-06-12', 'Ley 1459 de 2011'),
    ('MX', 'México',       'INTERESES', 0.10, '2013-07-11', 'Ley 1568 de 2012'),
    ('MX', 'México',       'REGALIAS',  0.10, '2013-07-11', 'Ley 1568 de 2012'),
    ('GB', 'Reino Unido',  'INTERESES', 0.10, '2019-12-13', 'Ley 1939 de 2018'),
    ('GB', 'Reino Unido',  'REGALIAS',  0.10, '2019-12-13', 'Ley 1939 de 2018'),
    ('FR', 'Francia',      'INTERESES', 0.10, '2022-01-01', 'Ley 2061 de 2020'),
    ('FR', 'Francia',      'REGALIAS',  0.10, '2022-01-01', 'Ley 2061 de 2020')
  ) AS x (pais, nombre, tipo, tarifa, desde, ley);

-- La residencia fiscal del proveedor del exterior, con su certificado.
CREATE TABLE tercero_residencia_fiscal (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid        NOT NULL REFERENCES empresa (id),
  tercero_id         uuid        NOT NULL,
  pais_codigo        char(2)     NOT NULL CHECK (pais_codigo ~ '^[A-Z]{2}$'),
  -- El período que cubre el certificado de residencia fiscal.
  certificado_desde  date        NOT NULL,
  certificado_hasta  date        NOT NULL,
  observacion        text,
  creado_por         uuid,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_residencia_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id),
  CONSTRAINT ck_residencia_periodo CHECK (certificado_hasta >= certificado_desde)
);
CREATE INDEX ix_residencia_tercero ON tercero_residencia_fiscal (empresa_id, tercero_id);

ALTER TABLE tercero_residencia_fiscal ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero_residencia_fiscal FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_residencia_aislada ON tercero_residencia_fiscal
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON tercero_residencia_fiscal TO gestion_app, gestion_provision;
