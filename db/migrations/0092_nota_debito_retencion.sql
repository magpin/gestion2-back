-- =============================================================================
-- 0092 — La nota débito de compra pasa por el motor de retenciones
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.7).
--
-- Lo que el proveedor cobra de más con una nota débito también lleva
-- retención. La nota guarda la entrada del motor como la compra (0088), para
-- que se pueda explicar y recalcular.

ALTER TABLE retencion_documento_entrada
  DROP CONSTRAINT retencion_documento_entrada_documento_tipo_check;
ALTER TABLE retencion_documento_entrada
  ADD CONSTRAINT retencion_documento_entrada_documento_tipo_check
    CHECK (documento_tipo IN ('COMPRA', 'NOTA_DEBITO_COMPRA'));
