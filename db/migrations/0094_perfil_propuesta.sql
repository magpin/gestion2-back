-- =============================================================================
-- 0094 — Propuestas de cambio del perfil tributario, desde la factura
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.8).
--
-- Cuando María lee una factura y lo que dice del proveedor —régimen simple,
-- responsable de IVA, gran contribuyente, autorretenedor, CIIU— no coincide con
-- su perfil vigente, queda una propuesta. No cambia nada: un DIRECTOR o
-- CONTADOR la aprueba (R-D8) y entonces se abre la versión nueva del perfil
-- desde la fecha de la factura, o la rechaza con el porqué y no se vuelve a
-- proponer lo mismo.

CREATE TABLE tercero_perfil_propuesta (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid        NOT NULL REFERENCES empresa (id),
  tercero_id          uuid        NOT NULL,
  documento_leido_id  uuid,
  -- La factura de donde salió, como la reconoce la persona: «FV-123».
  referencia          text,
  -- Desde cuándo rige, si se aprueba: la fecha de la factura.
  desde               date        NOT NULL,
  -- [{ campo, antes, propuesto, texto }]
  cambios             jsonb       NOT NULL CHECK (jsonb_typeof(cambios) = 'array'),
  -- Los cambios en forma canónica, para no proponer dos veces lo mismo.
  huella              text        NOT NULL,
  estado              text        NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (estado IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
  motivo              text,
  resuelta_por        uuid,
  resuelta_en         timestamptz,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_propuesta_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id),
  CONSTRAINT ck_propuesta_resuelta CHECK (
       (estado = 'PENDIENTE' AND resuelta_en IS NULL)
    OR (estado = 'APROBADA'  AND resuelta_en IS NOT NULL)
    OR (estado = 'RECHAZADA' AND resuelta_en IS NOT NULL
                             AND length(btrim(coalesce(motivo, ''))) > 0)
  )
);

-- Lo mismo no se propone dos veces mientras esté pendiente, ni después de
-- rechazado.
CREATE UNIQUE INDEX ux_propuesta_viva
  ON tercero_perfil_propuesta (empresa_id, tercero_id, huella)
  WHERE estado IN ('PENDIENTE', 'RECHAZADA');
CREATE INDEX ix_propuesta_pendiente
  ON tercero_perfil_propuesta (empresa_id, estado);

ALTER TABLE tercero_perfil_propuesta ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero_perfil_propuesta FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_perfil_propuesta_aislada ON tercero_perfil_propuesta
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON tercero_perfil_propuesta TO gestion_app, gestion_provision;
GRANT UPDATE (estado, motivo, resuelta_por, resuelta_en)
  ON tercero_perfil_propuesta TO gestion_app, gestion_provision;
