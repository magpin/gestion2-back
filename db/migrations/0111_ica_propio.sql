-- ICA propio: lo que la pantalla no puede deducir del libro
-- (Fase 3 de docs/planes/plan-pantallas-complementarias.md).
--
-- El impuesto de avisos y tableros es el 15 % del ICA, y solo lo paga quien
-- tiene un aviso o un tablero a la vista del público en ese municipio (Ley 14
-- de 1983, art. 37). El libro no lo sabe: lo dice la empresa, municipio por
-- municipio. Sin respuesta, el estimado lo incluye (es lo más común en un
-- local comercial) y la pantalla lo pregunta.

CREATE TABLE empresa_ica_propio (
  empresa_id        uuid         NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  municipio_codigo  char(5)      NOT NULL REFERENCES municipio (codigo),
  avisos_tableros   boolean      NOT NULL,
  actualizado_en    timestamptz  NOT NULL DEFAULT now(),
  actualizado_por   uuid,
  PRIMARY KEY (empresa_id, municipio_codigo)
);

ALTER TABLE empresa_ica_propio ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_ica_propio FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_empresa_ica_propio_aislado ON empresa_ica_propio
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON empresa_ica_propio TO gestion_app, gestion_provision;
GRANT UPDATE (avisos_tableros, actualizado_en, actualizado_por)
  ON empresa_ica_propio TO gestion_app, gestion_provision;
