-- 0053 — Hasta dónde llega el asistente: las reglas de autonomía.
--
-- Paso 8 de `docs/planes/asistente-conversacion.md`, en detalle en
-- `docs/planes/asistente-autonomia.md`. En el paso 7 el asistente propone y
-- una persona confirma, siempre. Con una regla, **una persona decide que para
-- un tipo de acción, bajo un monto, si todas las verificaciones pasan, la
-- propuesta se confirma sola.**
--
-- No es una casilla: es una política con alcance (la acción), límite (el
-- monto) y dueño (quien la activó). Y **solo se agrega**: cada cambio es una
-- fila nueva y la vigente es la última de su acción. Así se puede contestar
-- «¿qué regla valía el 12 de septiembre a las 10:40?», que es lo primero que
-- pregunta un revisor fiscal.
--
-- La fila `GENERAL` es el interruptor «Pausar la autonomía»: pausada, todo
-- vuelve a solo proponer sin perder las reglas.

CREATE TABLE asistente_regla (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid          NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  accion       text          NOT NULL,
  modo         text          NOT NULL,
  -- Hasta cuánto confirma sola, por propuesta. Uno de un peso más espera.
  limite       numeric(18,2),
  -- Quien la activó: la regla actúa con **sus** roles, mirados al actuar.
  activada_por uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creada_en    timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT ck_asistente_regla_accion CHECK (accion IN ('COBRO', 'PAGO', 'GENERAL')),
  CONSTRAINT ck_asistente_regla_modo CHECK (
    (accion = 'GENERAL' AND modo IN ('ACTIVA', 'PAUSADA') AND limite IS NULL)
    OR (accion <> 'GENERAL' AND (
      (modo = 'SOLO_PROPONER' AND limite IS NULL)
      OR (modo = 'CONFIRMAR_SI_PASA' AND limite IS NOT NULL AND limite > 0)
    ))
  )
);

-- La vigente de cada acción: la última.
CREATE INDEX ix_asistente_regla_vigente
  ON asistente_regla (empresa_id, accion, creada_en DESC);

COMMENT ON TABLE asistente_regla IS
  'Las reglas de autonomía del asistente, por acción, con su límite y quién las activó. Solo se agrega: la vigente de cada acción es la última fila. GENERAL es el interruptor de pausa.';

ALTER TABLE asistente_regla ENABLE ROW LEVEL SECURITY;
ALTER TABLE asistente_regla FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_asistente_regla_aislada ON asistente_regla
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin UPDATE ni DELETE: una regla no se edita, se reemplaza con otra fila.
REVOKE UPDATE ON asistente_regla FROM gestion_app, gestion_provision;
GRANT SELECT, INSERT ON asistente_regla TO gestion_app, gestion_provision;

-- La propuesta que confirmó una regla apunta a esa regla (la columna la dejó
-- la 0052 sin clave foránea, porque la tabla todavía no existía).
ALTER TABLE asistente_propuesta
  ADD CONSTRAINT fk_asistente_propuesta_regla
  FOREIGN KEY (confirmada_por_regla) REFERENCES asistente_regla (id) ON DELETE RESTRICT;
