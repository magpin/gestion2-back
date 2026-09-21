-- 0050 — Conversar con el asistente.
--
-- Paso 4a de `docs/planes/asistente-conversacion.md`: el contrato del módulo
-- `conversacion`, que es el único que escribe estas dos tablas.
--
-- Se guarda por las mismas dos razones que `documento_leido` (0048), y otra vez
-- manda la segunda:
--
--   1. Una conversación que se pierde al recargar no sirve para trabajar.
--   2. Trazabilidad. En un sistema contable, poder decir qué se le preguntó al
--      asistente, qué contestó, con qué modelo y cuánto costó es parte del
--      expediente.
--
-- Lo que estas tablas **no** son: la configuración ni los datos de la empresa.
-- En este paso el asistente no ve ni escribe nada del negocio; solo conversa.

CREATE TABLE conversacion (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  -- De quién es. Cada persona ve solo las suyas: lo filtra el servicio, porque
  -- la sesión de la base sabe la empresa pero no el usuario (`app_empresa_id()`
  -- existe; un `app_usuario_id()` tocaría `TxService` y todos los módulos).
  usuario_id   uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creada_en    timestamptz NOT NULL DEFAULT now(),
  -- «Empezar de nuevo» archiva, no borra: lo conversado es historial.
  archivada_en timestamptz,

  CONSTRAINT ck_conversacion_archivada
    CHECK (archivada_en IS NULL OR archivada_en >= creada_en)
);

-- Una vigente por persona y empresa. La lista de conversaciones del diseño es
-- de otra pantalla; esta tabla ya la admite, porque las archivadas se acumulan.
CREATE UNIQUE INDEX uq_conversacion_vigente
  ON conversacion (empresa_id, usuario_id)
  WHERE archivada_en IS NULL;

CREATE INDEX ix_conversacion_usuario
  ON conversacion (empresa_id, usuario_id, creada_en DESC);

-- Archivar es lo único que se le puede hacer a una conversación, y una sola
-- vez: de NULL a una fecha. Desarchivar sería reabrir un hilo con la historia
-- cortada por otro que empezó después.
CREATE OR REPLACE FUNCTION fn_conversacion_solo_archivar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.empresa_id, NEW.usuario_id, NEW.creada_en)
     IS DISTINCT FROM ROW(OLD.id, OLD.empresa_id, OLD.usuario_id, OLD.creada_en) THEN
    RAISE EXCEPTION 'Una conversación no se edita: solo se archiva.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archivada_en IS NOT NULL AND NEW.archivada_en IS DISTINCT FROM OLD.archivada_en THEN
    RAISE EXCEPTION 'Una conversación archivada no se desarchiva: se empieza otra.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_conversacion_solo_archivar
  BEFORE UPDATE ON conversacion
  FOR EACH ROW EXECUTE FUNCTION fn_conversacion_solo_archivar();

CREATE TABLE conversacion_turno (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  conversacion_id uuid        NOT NULL REFERENCES conversacion (id) ON DELETE CASCADE,
  -- El lugar en el hilo, desde 1. Lo calcula el servicio con la conversación
  -- bloqueada; el UNIQUE de abajo frena la carrera si alguien se lo saltea.
  orden           integer     NOT NULL CHECK (orden >= 1),
  autor           text        NOT NULL CHECK (autor IN ('PERSONA', 'ASISTENTE')),
  texto           text        NOT NULL,
  -- Cómo terminó el turno del asistente. El de la persona es siempre COMPLETO.
  --   COMPLETO  — contestó entero.
  --   CORTADO   — la persona cerró o detuvo a mitad; `texto` es lo que alcanzó.
  --   RECHAZADO — el modelo, y su respaldo, declinaron. `texto` queda vacío:
  --               lo que se haya escrito antes del rechazo se descarta.
  --   FALLO     — la API no respondió, o respondió con error.
  estado          text        NOT NULL CHECK (estado IN (
                                'COMPLETO', 'CORTADO', 'RECHAZADO', 'FALLO'
                              )),
  -- El modelo que efectivamente contestó. Con respaldo por rechazo puede no
  -- ser el que se pidió, y eso es justo lo que hay que poder ver después.
  modelo          text        CHECK (modelo IS NULL OR length(btrim(modelo)) > 0),
  -- Los tokens de la llamada tal como los devolvió la API: entrada, salida,
  -- escritura y lectura de caché. Es lo que permite decir cuánto costó.
  uso             jsonb       CHECK (uso IS NULL OR jsonb_typeof(uso) = 'object'),
  -- Por qué no terminó bien, en palabras para la persona. Nunca una traza.
  motivo          text        CHECK (motivo IS NULL OR length(btrim(motivo)) > 0),
  creado_en       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_conversacion_turno_orden UNIQUE (conversacion_id, orden),

  -- Lo que la persona escribió: completo, con texto, sin modelo ni costo.
  CONSTRAINT ck_conversacion_turno_persona CHECK (
    autor <> 'PERSONA' OR (
      estado = 'COMPLETO' AND length(btrim(texto)) > 0
      AND modelo IS NULL AND uso IS NULL AND motivo IS NULL
    )
  ),
  -- Lo que contestó el asistente: el estado y el resto no se contradicen.
  CONSTRAINT ck_conversacion_turno_asistente CHECK (
    autor <> 'ASISTENTE' OR CASE estado
      WHEN 'COMPLETO'  THEN length(btrim(texto)) > 0 AND modelo IS NOT NULL AND motivo IS NULL
      WHEN 'CORTADO'   THEN modelo IS NOT NULL
      WHEN 'RECHAZADO' THEN texto = '' AND motivo IS NOT NULL
      WHEN 'FALLO'     THEN motivo IS NOT NULL
    END
  ),
  -- Un turno de más de 40.000 caracteres no es una pregunta: es un documento
  -- pegado, y para eso está la lectura. El DTO pone un límite más bajo.
  CONSTRAINT ck_conversacion_turno_largo CHECK (length(texto) <= 40000)
);

-- El hilo en orden —la consulta de cada turno, armar el historial— la sirve el
-- índice del UNIQUE (conversacion_id, orden). Uno aparte sería el mismo dos veces.

-- Un turno entra solo a una conversación vigente y de su misma empresa. La
-- clave foránea no mira la empresa, y una conversación archivada está cerrada.
CREATE OR REPLACE FUNCTION fn_conversacion_turno_vigente() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c conversacion%ROWTYPE;
BEGIN
  SELECT * INTO c FROM conversacion WHERE id = NEW.conversacion_id;
  IF c.empresa_id IS DISTINCT FROM NEW.empresa_id THEN
    RAISE EXCEPTION 'El turno y su conversación son de empresas distintas.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF c.archivada_en IS NOT NULL THEN
    RAISE EXCEPTION 'Esa conversación está archivada: se sigue en la vigente.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_conversacion_turno_vigente
  BEFORE INSERT ON conversacion_turno
  FOR EACH ROW EXECUTE FUNCTION fn_conversacion_turno_vigente();

COMMENT ON TABLE conversacion IS
  'Una conversación de una persona con el asistente, en una empresa. Una vigente por persona; las archivadas quedan como historial. Cada persona ve solo las suyas (lo filtra el servicio).';

COMMENT ON TABLE conversacion_turno IS
  'Un turno de la conversación: lo que escribió la persona o lo que contestó el asistente. Solo se agrega: la aplicación no tiene UPDATE ni DELETE sobre esta tabla. El turno del asistente se inserta una vez, al terminar, con su estado, el modelo que contestó y su uso de tokens.';

COMMENT ON COLUMN conversacion_turno.uso IS
  'El usage de la API: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens. Con esto y el modelo se calcula el costo del turno.';

ALTER TABLE conversacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversacion FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_conversacion_aislada ON conversacion
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

ALTER TABLE conversacion_turno ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversacion_turno FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_conversacion_turno_aislado ON conversacion_turno
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin DELETE, como todo el esquema. De la conversación solo se puede tocar
-- `archivada_en`; de los turnos, nada: la historia no se edita, y editarla
-- además tiraría el caché del modelo sin que nadie lo note.
--
-- **El REVOKE es necesario.** La 0044 dejó `ALTER DEFAULT PRIVILEGES` para que
-- toda tabla nueva nazca con SELECT, INSERT y UPDATE: es una red para el que se
-- olvida del GRANT. Acá la red da de más, y un GRANT más estrecho no la quita:
-- los privilegios se suman. Probado: sin esta línea, `gestion_app` editaba un
-- turno y solo lo frenaba un CHECK.
REVOKE UPDATE ON conversacion, conversacion_turno FROM gestion_app, gestion_provision;

GRANT SELECT, INSERT                ON conversacion       TO gestion_app, gestion_provision;
GRANT UPDATE (archivada_en)         ON conversacion       TO gestion_app, gestion_provision;
GRANT SELECT, INSERT                ON conversacion_turno TO gestion_app, gestion_provision;
