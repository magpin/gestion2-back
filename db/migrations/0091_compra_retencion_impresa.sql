-- =============================================================================
-- 0091 — La retención que el proveedor imprimió en la factura
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.6).
--
-- Cuando María lee la factura, trae la retención que el proveedor escribió. Se
-- registraba la del motor —la de la norma— y la diferencia quedaba solo en el
-- texto del motivo. Guardada aparte, Revisión puede encontrar las compras donde
-- el proveedor calculó distinto y decirlo. No cambia lo registrado: manda el
-- motor.

ALTER TABLE compra_documento
  ADD COLUMN retencion_impresa numeric(18,2)
    CHECK (retencion_impresa IS NULL OR retencion_impresa >= 0);

COMMENT ON COLUMN compra_documento.retencion_impresa IS
  'La retención que traía impresa la factura del proveedor, si María la leyó. Solo para comparar: se registra la del motor.';
