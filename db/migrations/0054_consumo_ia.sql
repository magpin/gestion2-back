-- 0054 — Lo que falta para medir el consumo de la IA.
--
-- Entrega C1 de `docs/planes/consumo-ia.md`. El tablero de consumo necesita,
-- de cada llamada al modelo, los tokens, el modelo y cuánto tardó:
--
--   - **La lectura de documentos** calculaba los tokens y solo los escribía en
--     el registro del servidor: se perdían. Ahora se guardan con el documento.
--   - **El chat** ya guardaba los tokens y el modelo de cada respuesta (0050);
--     le faltaba cuánto tardó y cuántas vueltas al modelo dio (una por
--     consulta, más la que contesta).
--
-- Todo es opcional: lo que se hizo antes de esta migración no lo tiene, y el
-- tablero lo dice en vez de mostrar ceros.

ALTER TABLE documento_leido
  ADD COLUMN uso         jsonb,
  ADD COLUMN modelo      text,
  ADD COLUMN duracion_ms integer,
  ADD CONSTRAINT ck_documento_leido_uso
    CHECK (uso IS NULL OR jsonb_typeof(uso) = 'object'),
  ADD CONSTRAINT ck_documento_leido_duracion
    CHECK (duracion_ms IS NULL OR duracion_ms >= 0);

COMMENT ON COLUMN documento_leido.uso IS
  'El uso de la API al leer: entrada, salida, cacheLeido y cacheEscrito. NULL en lo leído antes de la 0054, o si la lectura falló antes de llamar al modelo.';

ALTER TABLE conversacion_turno
  ADD COLUMN duracion_ms integer,
  ADD COLUMN vueltas     smallint,
  ADD CONSTRAINT ck_conversacion_turno_duracion
    CHECK (duracion_ms IS NULL OR duracion_ms >= 0),
  ADD CONSTRAINT ck_conversacion_turno_vueltas
    CHECK (vueltas IS NULL OR vueltas BETWEEN 1 AND 20);

COMMENT ON COLUMN conversacion_turno.vueltas IS
  'Cuántas llamadas al modelo hizo la respuesta: una por cada ronda de consultas, más la que contesta. NULL en las preguntas y en lo anterior a la 0054.';

-- Sin permisos nuevos: `documento_leido` tiene UPDATE a nivel de tabla (0048)
-- y `conversacion_turno` tiene INSERT a nivel de tabla (0050), así que las
-- columnas nuevas ya se pueden escribir. `gestion_provision`, que lee para el
-- tablero, ya tiene SELECT sobre las dos.
