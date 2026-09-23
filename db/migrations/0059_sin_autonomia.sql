-- 0059 — María no actúa sola.
--
-- Hasta ahora, una empresa podía autorizar al asistente a registrar cobros y
-- pagos sin preguntar: eran las reglas de `asistente_regla`, y la propuesta
-- guardaba en `confirmada_por_regla` cuál la había resuelto.
--
-- Por decisión del dueño eso se retira. Queda una sola norma, fija y para
-- todas las empresas: **María propone, una persona confirma**. Proponer sigue
-- igual; lo que desaparece es que pueda confirmarse a sí misma.
--
-- **El orden de esta migración importa**, y el primer paso es el que no se
-- puede saltear.

-- -----------------------------------------------------------------------------
-- 1. Rescatar quién fue responsable, antes de perder de dónde sacarlo
-- -----------------------------------------------------------------------------
-- Una propuesta que confirmó una regla tiene `resuelta_por` en nulo: no la
-- resolvió una persona. Si se borra la columna sin más, esas filas quedan
-- confirmadas **sin nadie atribuible**, que es exactamente lo que pregunta un
-- auditor cuando revisa un asiento.
--
-- Quien activó la regla es el responsable: autorizó que se hiciera solo. Se
-- copia a `resuelta_por` para que la cadena no se corte.
UPDATE asistente_propuesta p
   SET resuelta_por = r.activada_por
  FROM asistente_regla r
 WHERE p.confirmada_por_regla = r.id
   AND p.resuelta_por IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Soltar el permiso que nombra la columna
-- -----------------------------------------------------------------------------
-- El GRANT de la 0052 la lista una por una, así que hay que regrabarlo sin
-- ella o el DROP falla.
REVOKE UPDATE ON asistente_propuesta FROM gestion_app, gestion_provision;
GRANT UPDATE (estado, resuelta_en, resuelta_por, cuerpo_confirmado,
              resultado, error)
  ON asistente_propuesta TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 3. Cortar el vínculo y borrar la tabla
-- -----------------------------------------------------------------------------
ALTER TABLE asistente_propuesta
  DROP CONSTRAINT IF EXISTS fk_asistente_propuesta_regla,
  DROP COLUMN IF EXISTS confirmada_por_regla;

DROP TABLE IF EXISTS asistente_regla;
