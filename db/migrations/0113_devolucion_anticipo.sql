-- Devolver un anticipo (Fase 5 de docs/planes/plan-pantallas-complementarias.md, PC19).
--
-- Un anticipo baja de dos maneras: se cruza con una factura (cruce_cartera o
-- cruce_pago) o se devuelve. La devolución es un movimiento por concepto al
-- revés del anticipo —sale la plata al cliente, o entra la que devuelve el
-- proveedor— con el mismo concepto, y `devuelve_a` dice a cuál anticipo
-- descuenta. Anularla lo restablece.

ALTER TABLE movimiento_concepto
  ADD COLUMN devuelve_a uuid,
  ADD CONSTRAINT fk_movimiento_concepto_devuelve FOREIGN KEY (devuelve_a, empresa_id)
    REFERENCES movimiento_concepto (id, empresa_id) ON DELETE RESTRICT,
  DROP CONSTRAINT movimiento_concepto_origen_check,
  ADD CONSTRAINT movimiento_concepto_origen_check CHECK (origen IN
    ('MANUAL', 'RECIBO_CAJA', 'COMPROBANTE_EGRESO', 'GMF', 'DEVOLUCION_ANTICIPO')),
  ADD CONSTRAINT ck_movimiento_concepto_devuelve CHECK (
    (origen = 'DEVOLUCION_ANTICIPO') = (devuelve_a IS NOT NULL));

CREATE INDEX ix_movimiento_concepto_devuelve ON movimiento_concepto (devuelve_a)
  WHERE devuelve_a IS NOT NULL;
