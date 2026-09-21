-- 0052 — Lo que el asistente propone hacer, y lo que la persona decidió.
--
-- Paso 7 de `docs/planes/asistente-conversacion.md`, en detalle en
-- `docs/planes/asistente-acciones.md`: **el asistente propone y una persona
-- confirma.** Una propuesta es un cobro o un pago ya armado y verificado en
-- seco; nada se registra hasta que alguien aprieta Confirmar.
--
-- Por qué se guarda, y no vive solo en la pantalla:
--
--   1. La confirmación tiene que valer una sola vez, aunque haya doble clic o
--      dos pestañas. Eso lo garantiza la base (el trigger de abajo), no el
--      botón.
--   2. Trazabilidad: qué propuso el asistente, qué confirmó la persona —si lo
--      corrigió antes, queda en `cuerpo_confirmado`—, cuándo y con qué
--      resultado.
--   3. El paso 8 (`asistente-autonomia.md`) mide los aciertos por tipo con
--      estas filas. Por eso `cuerpo_confirmado` y `confirmada_por_regla` están
--      desde ahora: los aciertos se juntan desde el primer día.

CREATE TABLE asistente_propuesta (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  -- Quien pidió, que es quien la puede confirmar.
  usuario_id           uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  -- La respuesta del asistente que la trajo.
  turno_id             uuid        NOT NULL REFERENCES conversacion_turno (id) ON DELETE CASCADE,
  accion               text        NOT NULL,
  -- La factura o la compra sobre la que actúa.
  documento_id         uuid        NOT NULL,
  -- Lo que se va a mandar al confirmar, tal cual: fecha y medios de pago.
  cuerpo               jsonb       NOT NULL,
  -- Lo que mostró la verificación en seco: el documento como quedaría y los
  -- asientos que se harían. Se muestra; no se vuelve a usar para registrar.
  vista_previa         jsonb       NOT NULL,
  estado               text        NOT NULL DEFAULT 'PENDIENTE',
  creada_en            timestamptz NOT NULL DEFAULT now(),
  -- Una propuesta de ayer sobre un saldo que cambió no se confirma.
  vence_en             timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  resuelta_en          timestamptz,
  resuelta_por         uuid        REFERENCES usuario (id) ON DELETE RESTRICT,
  -- Lo que de verdad se registró. Distinto de `cuerpo` = la persona corrigió.
  cuerpo_confirmado    jsonb,
  -- La regla de autonomía que la confirmó sola (paso 8). NULL = una persona.
  confirmada_por_regla uuid,
  -- Lo que devolvió el registro: el documento después del cobro o el pago.
  resultado            jsonb,
  -- El último intento de confirmar que falló. La propuesta sigue pendiente.
  error                text,

  CONSTRAINT ck_asistente_propuesta_accion CHECK (accion IN ('COBRO', 'PAGO')),
  CONSTRAINT ck_asistente_propuesta_estado
    CHECK (estado IN ('PENDIENTE', 'CONFIRMADA', 'DESCARTADA', 'VENCIDA')),
  -- Resuelta = tiene quién y cuándo; pendiente = no los tiene.
  CONSTRAINT ck_asistente_propuesta_resuelta CHECK (
    (estado = 'PENDIENTE' AND resuelta_en IS NULL AND resuelta_por IS NULL)
    OR (estado <> 'PENDIENTE' AND resuelta_en IS NOT NULL)
  ),
  -- Confirmada = sabe qué se registró y qué devolvió.
  CONSTRAINT ck_asistente_propuesta_confirmada CHECK (
    estado <> 'CONFIRMADA' OR (cuerpo_confirmado IS NOT NULL AND resultado IS NOT NULL)
  ),
  CONSTRAINT ck_asistente_propuesta_error
    CHECK (error IS NULL OR char_length(error) BETWEEN 1 AND 1000)
);

CREATE INDEX ix_asistente_propuesta_turno ON asistente_propuesta (turno_id);
-- Para el resumen y los aciertos del paso 8: por acción y estado.
CREATE INDEX ix_asistente_propuesta_accion ON asistente_propuesta (empresa_id, accion, estado);

-- Una propuesta cuelga de una respuesta del asistente de su misma empresa.
CREATE OR REPLACE FUNCTION fn_asistente_propuesta_turno() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t conversacion_turno%ROWTYPE;
BEGIN
  SELECT * INTO t FROM conversacion_turno WHERE id = NEW.turno_id;
  IF t.empresa_id IS DISTINCT FROM NEW.empresa_id THEN
    RAISE EXCEPTION 'La propuesta y su turno son de empresas distintas.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF t.autor IS DISTINCT FROM 'ASISTENTE' THEN
    RAISE EXCEPTION 'Solo una respuesta del asistente trae propuestas.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_asistente_propuesta_turno
  BEFORE INSERT ON asistente_propuesta
  FOR EACH ROW EXECUTE FUNCTION fn_asistente_propuesta_turno();

-- **Se resuelve una sola vez.** Mientras está pendiente solo cambian el
-- estado, quién y cuándo la resolvió, lo confirmado y el error. Resuelta, no
-- cambia nada más. Es lo que impide cobrar dos veces con un doble clic: la
-- segunda confirmación encuentra la fila ya resuelta y el trigger la frena,
-- aunque el servicio se hubiera equivocado.
CREATE OR REPLACE FUNCTION fn_asistente_propuesta_una_vez() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'Esa propuesta ya se resolvió: %.', lower(OLD.estado)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.turno_id IS DISTINCT FROM OLD.turno_id
     OR NEW.accion IS DISTINCT FROM OLD.accion
     OR NEW.documento_id IS DISTINCT FROM OLD.documento_id
     OR NEW.cuerpo IS DISTINCT FROM OLD.cuerpo
     OR NEW.vista_previa IS DISTINCT FROM OLD.vista_previa
     OR NEW.creada_en IS DISTINCT FROM OLD.creada_en
     OR NEW.vence_en IS DISTINCT FROM OLD.vence_en THEN
    RAISE EXCEPTION 'Lo que el asistente propuso no se edita: se confirma, se descarta o vence.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_asistente_propuesta_una_vez
  BEFORE UPDATE ON asistente_propuesta
  FOR EACH ROW EXECUTE FUNCTION fn_asistente_propuesta_una_vez();

COMMENT ON TABLE asistente_propuesta IS
  'Un cobro o un pago que el asistente armó y verificó en seco, esperando que la persona que lo pidió lo confirme. Se resuelve una sola vez (confirmada, descartada o vencida). Cada persona ve y confirma solo las suyas (lo filtra el servicio).';

ALTER TABLE asistente_propuesta ENABLE ROW LEVEL SECURITY;
ALTER TABLE asistente_propuesta FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_asistente_propuesta_aislada ON asistente_propuesta
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin DELETE, y UPDATE solo de lo que cambia al resolver. El REVOKE, por la
-- red de la 0044 (ver 0050).
REVOKE UPDATE ON asistente_propuesta FROM gestion_app, gestion_provision;
GRANT SELECT, INSERT ON asistente_propuesta TO gestion_app, gestion_provision;
GRANT UPDATE (estado, resuelta_en, resuelta_por, cuerpo_confirmado,
              confirmada_por_regla, resultado, error)
  ON asistente_propuesta TO gestion_app, gestion_provision;
