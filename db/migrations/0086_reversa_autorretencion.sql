-- =============================================================================
-- 0086 — La nota crédito de venta reversa su autorretención
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 6 (§6.0).
--
-- La autorretención de una venta (0084) quedaba viva aunque la venta se
-- devolviera con una nota crédito: el 350 la seguía sumando y la 236575 no
-- bajaba. La reversa es una fila nueva en negativo, como en compras, y su
-- documento es la nota: `retencion_calculada` tiene que admitirla.

ALTER TABLE retencion_calculada
  DROP CONSTRAINT retencion_calculada_documento_tipo_check;

ALTER TABLE retencion_calculada
  ADD CONSTRAINT retencion_calculada_documento_tipo_check CHECK (documento_tipo IN
    ('COMPRA', 'NOTA_CREDITO_COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA', 'NOTA_CREDITO_VENTA'));
