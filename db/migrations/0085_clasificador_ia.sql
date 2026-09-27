-- =============================================================================
-- 0085 — El clasificador con IA y la medición de aciertos
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 5.
--
-- 1. `retencion_clasificacion_ia`: lo que la IA propuso para un renglón de un
--    proveedor, cuando ninguna fuente determinista dijo nada. Sirve de caché:
--    el mismo renglón del mismo proveedor no se vuelve a preguntar (cada
--    simulación de la pantalla pasaría por el modelo). Guarda también los
--    tokens, el modelo y cuánto tardó, para el tablero de consumo de IA.
--    **Nunca se aplica sola**: es la fuente 5, siempre «La deduje».
-- 2. `retencion_clasificacion_uso`: por cada renglón registrado, qué fuente
--    propuso qué concepto y qué eligió la persona. De ahí salen los aciertos
--    por fuente. Solo inserción.

CREATE TABLE retencion_clasificacion_ia (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid        NOT NULL REFERENCES empresa (id),
  tercero_id            uuid        NOT NULL,
  llave_renglon         text        NOT NULL CHECK (length(llave_renglon) BETWEEN 3 AND 500),
  -- PROPUESTA: dio un concepto de la lista. FUERA_DE_LISTA: dio uno que no
  -- existe y se descartó. FALLO: el modelo no contestó; se reintenta después.
  estado                text        NOT NULL CHECK (estado IN ('PROPUESTA', 'FUERA_DE_LISTA', 'FALLO')),
  concepto_nacional_id  uuid        REFERENCES retencion_concepto_nacional (id),
  razon                 text        CHECK (razon IS NULL OR length(razon) <= 600),
  alternativas          text[]      NOT NULL DEFAULT '{}',
  modelo                text,
  uso                   jsonb       CHECK (uso IS NULL OR jsonb_typeof(uso) = 'object'),
  duracion_ms           integer     CHECK (duracion_ms IS NULL OR duracion_ms >= 0),
  creado_en             timestamptz NOT NULL DEFAULT now(),
  creado_por            uuid,
  CONSTRAINT fk_clasificacion_ia_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id),
  CONSTRAINT ck_clasificacion_ia_concepto
    CHECK ((estado = 'PROPUESTA') = (concepto_nacional_id IS NOT NULL)),
  CONSTRAINT uq_clasificacion_ia UNIQUE (empresa_id, tercero_id, llave_renglon)
);

ALTER TABLE retencion_clasificacion_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_clasificacion_ia FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_clasificacion_ia_aislado ON retencion_clasificacion_ia
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- UPDATE: un FALLO se reintenta sobre la misma fila.
GRANT SELECT, INSERT, UPDATE ON retencion_clasificacion_ia TO gestion_app;
REVOKE DELETE ON retencion_clasificacion_ia FROM gestion_app;
GRANT SELECT ON retencion_clasificacion_ia TO gestion_provision;

CREATE TABLE retencion_clasificacion_uso (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid        NOT NULL REFERENCES empresa (id),
  documento_tipo      text        NOT NULL,
  documento_id        uuid        NOT NULL,
  orden               integer     NOT NULL,
  -- La fuente que propuso; NULL si ninguna dijo nada y se preguntó.
  origen_propuesto    text        CHECK (origen_propuesto IS NULL OR origen_propuesto IN
                        ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA')),
  concepto_propuesto  text,
  concepto_elegido    text        NOT NULL,
  acerto              boolean     NOT NULL,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_clasificacion_uso_acierto
    CHECK (acerto = (concepto_propuesto IS NOT DISTINCT FROM concepto_elegido))
);

CREATE INDEX ix_clasificacion_uso_empresa ON retencion_clasificacion_uso (empresa_id, creado_en);

ALTER TABLE retencion_clasificacion_uso ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_clasificacion_uso FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_clasificacion_uso_aislado ON retencion_clasificacion_uso
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON retencion_clasificacion_uso TO gestion_app;
REVOKE UPDATE, DELETE ON retencion_clasificacion_uso FROM gestion_app;
GRANT SELECT ON retencion_clasificacion_uso TO gestion_provision;
