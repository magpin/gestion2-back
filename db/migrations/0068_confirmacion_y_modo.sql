-- 0068 — Lo confirmado queda confirmado, y el modo elegido queda elegido.
--
-- Dos cosas que el modo IA de la configuración necesitaba recordar y solo
-- recordaba la pantalla mientras estaba abierta:
--
-- 1. **Que una lectura ya se confirmó.** Volver al modo IA volvía a ofrecer
--    «Todo correcto» sobre datos ya guardados, y pedía guardarlos otra vez: un
--    bucle. Ahora queda cuándo se confirmó y qué pasó —lo aplicado y lo que
--    quedó sin aplicar, con su motivo—, para mostrarlo sin volver a pedirlo.
-- 2. **Con qué modo se está configurando la empresa.** Quien eligió «Con IA» se
--    queda en IA hasta terminar: los pasos manuales lo sacaban del modo y lo
--    devolvían al principio.

ALTER TABLE documento_leido
  ADD COLUMN confirmado_en timestamptz,
  ADD COLUMN confirmacion  jsonb
    CHECK (confirmacion IS NULL OR jsonb_typeof(confirmacion) = 'object');

COMMENT ON COLUMN documento_leido.confirmacion IS
  'Lo que paso al confirmar la lectura: {aplicados, sinAplicar}. Con esto la pantalla no vuelve a pedir que se confirme lo que ya se guardo.';

ALTER TABLE empresa
  ADD COLUMN modo_configuracion text
    CHECK (modo_configuracion IS NULL OR modo_configuracion IN ('IA', 'MANUAL'));

COMMENT ON COLUMN empresa.modo_configuracion IS
  'Como se eligio configurar la empresa. IA la mantiene en el modo IA hasta terminar. NULL: todavia no se eligio.';

GRANT UPDATE (modo_configuracion) ON empresa TO gestion_app, gestion_provision;
