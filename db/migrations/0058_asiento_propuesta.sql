-- 0058 — De qué propuesta de María salió un asiento.
--
-- La pantalla del asiento tiene que poder decir «Propuesto por María», y hoy
-- no hay con qué: la propuesta guarda el id de la **factura**, no el del
-- asiento. Si una factura tuvo dos cobros —uno propuesto y otro digitado a
-- mano— no hay forma de saber cuál asiento salió de cuál, y la etiqueta sería
-- una suposición.
--
-- La columna va en `asiento` y no en la propuesta porque la pregunta se hace
-- desde acá: mirando un asiento, saber de dónde vino. Al revés ya se puede.
--
-- Queda **nula en todo lo anterior**, y está bien: esos asientos los digitó
-- una persona o salieron de un documento, y ninguno pasó por una propuesta.

ALTER TABLE asiento
  ADD COLUMN IF NOT EXISTS propuesta_id uuid;

ALTER TABLE asiento
  DROP CONSTRAINT IF EXISTS fk_asiento_propuesta;

-- `ON DELETE SET NULL`: si alguna vez se borra una propuesta, el asiento se
-- queda —es un hecho contable— y solo pierde de dónde vino.
ALTER TABLE asiento
  ADD CONSTRAINT fk_asiento_propuesta
    FOREIGN KEY (propuesta_id) REFERENCES asistente_propuesta (id) ON DELETE SET NULL;

-- Parcial: los asientos con propuesta son una minoría y el índice solo sirve
-- para buscarlos.
CREATE INDEX IF NOT EXISTS ix_asiento_propuesta
  ON asiento (propuesta_id)
  WHERE propuesta_id IS NOT NULL;

COMMENT ON COLUMN asiento.propuesta_id IS
  'La propuesta del asistente que lo originó, si salió de una. Nulo si lo hizo una persona.';
