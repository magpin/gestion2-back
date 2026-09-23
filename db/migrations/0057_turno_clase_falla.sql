-- 0057 — Por qué falló un turno del asistente.
--
-- Hasta ahora, un turno en `FALLO` guardaba el `motivo` —la frase para la
-- persona— y nada más. Cuando la cuenta del proveedor se quedó sin saldo, el
-- chat dijo «No pude contestar esa pregunta. Probá de nuevo», que manda a
-- reescribir una pregunta que estaba bien, y desde la base no había forma de
-- saber qué había pasado: hubo que llamar a la API del proveedor a mano para
-- descubrirlo.
--
-- Dos columnas arreglan las dos cosas:
--
--   - `clase` es **de qué tipo** fue la falla. El servicio ya la calculaba
--     para elegir el mensaje, pero la descartaba. Con ella, la pantalla puede
--     mostrar la cara que corresponde —dormida si el asistente no está, «no
--     pude» si falló— en vez de la misma para todo.
--   - `detalle` es lo que dijo el proveedor, para quien administra. **No se
--     le muestra a la persona**: es para el tablero y para el rato en que
--     alguien tenga que averiguar por qué el asistente dejó de contestar.
--
-- Las dos son opcionales: los turnos que salieron bien no tienen ninguna, y
-- los que ya están guardados se quedan como están.

ALTER TABLE conversacion_turno
  ADD COLUMN IF NOT EXISTS clase   text,
  ADD COLUMN IF NOT EXISTS detalle text;

ALTER TABLE conversacion_turno
  DROP CONSTRAINT IF EXISTS ck_conversacion_turno_clase;

-- Las cuatro que el proveedor distingue hoy. Una clase en un turno que salió
-- bien sería contradictorio, y por eso el CHECK también la prohíbe.
ALTER TABLE conversacion_turno
  ADD CONSTRAINT ck_conversacion_turno_clase CHECK (
    clase IS NULL
    OR (
      estado IN ('FALLO', 'RECHAZADO')
      AND clase IN ('SIN_CLAVE', 'SIN_SALDO', 'NO_DISPONIBLE', 'PETICION', 'FALLA')
    )
  );

ALTER TABLE conversacion_turno
  DROP CONSTRAINT IF EXISTS ck_conversacion_turno_detalle;

ALTER TABLE conversacion_turno
  ADD CONSTRAINT ck_conversacion_turno_detalle CHECK (
    detalle IS NULL OR length(btrim(detalle)) > 0
  );

COMMENT ON COLUMN conversacion_turno.clase IS
  'De qué tipo fue la falla. Decide qué cara y qué frase muestra la pantalla.';
COMMENT ON COLUMN conversacion_turno.detalle IS
  'Lo que dijo el proveedor. Para quien administra, nunca para la persona.';
