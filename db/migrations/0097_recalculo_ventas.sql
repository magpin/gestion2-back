-- =============================================================================
-- 0097 — El recálculo por cambio de norma también cubre las ventas
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.10).
--
-- La autorretención de renta de una venta (especial por CIIU, o por
-- resolución) también cambia si cambia la norma. La venta guarda lo que
-- recibió el motor, como la compra, y sus diferencias van a la misma lista.

ALTER TABLE retencion_documento_entrada
  DROP CONSTRAINT retencion_documento_entrada_documento_tipo_check;
ALTER TABLE retencion_documento_entrada
  ADD CONSTRAINT retencion_documento_entrada_documento_tipo_check
    CHECK (documento_tipo IN ('COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA'));

ALTER TABLE retencion_recalculo_diferencia
  DROP CONSTRAINT retencion_recalculo_diferencia_documento_tipo_check;
ALTER TABLE retencion_recalculo_diferencia
  ADD CONSTRAINT retencion_recalculo_diferencia_documento_tipo_check
    CHECK (documento_tipo IN ('COMPRA', 'VENTA'));
