-- =============================================================================
-- 0072 — La bienvenida de María, una sola vez
-- =============================================================================
--
-- Al terminar la configuración se muestra la bienvenida de María («Ya quedó
-- lista tu contabilidad»). Se muestra **una vez por empresa**, no por usuario:
-- es el cierre de configurarla, y eso pasa una sola vez. Quien entre después,
-- sea quien sea, va directo al tablero.
--
-- Queda cuándo se vio, no un sí o no: sirve para saber cuándo empezó a operar.
--
-- Sin relleno para las empresas que ya terminaron: la bienvenida solo se ofrece
-- en el momento de completar la configuración, y esas ya pasaron por ahí.

ALTER TABLE empresa
  ADD COLUMN bienvenida_vista_en timestamptz;

COMMENT ON COLUMN empresa.bienvenida_vista_en IS
  'Cuando se mostro la bienvenida de Maria al terminar la configuracion. NULL: todavia no se mostro. Se marca una sola vez.';

GRANT UPDATE (bienvenida_vista_en) ON empresa TO gestion_app, gestion_provision;
