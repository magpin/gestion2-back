-- =============================================================================
-- 0030_producto_entrada_compra — el tipo de movimiento que Compras necesita
-- =============================================================================
-- `0026` sumó `'SALIDA_VENTA'` y dejó anotado explícitamente que
-- `'ENTRADA_COMPRA'` quedaba para cuando Compras (módulo 5) le tocara. Le
-- tocó — ver `docs/planes/compras-backend.md`.

ALTER TABLE producto_movimiento DROP CONSTRAINT ck_movimiento_tipo;

ALTER TABLE producto_movimiento ADD CONSTRAINT ck_movimiento_tipo CHECK (
  tipo IN ('ENTRADA_INICIAL', 'ENTRADA_AJUSTE', 'ENTRADA_COMPRA',
           'SALIDA_AJUSTE', 'SALIDA_VENTA')
);
