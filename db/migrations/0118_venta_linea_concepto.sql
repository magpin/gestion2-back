-- Ventas con servicios y otros ingresos (Fase 8 de
-- docs/planes/plan-pantallas-complementarias.md, pantalla 13).
--
-- Una línea de venta deja de exigir producto. Puede ser:
--   · de producto, como siempre: precio de lista, kardex y costo;
--   · de concepto de INGRESO: un servicio (41, operacional) o un otro ingreso
--     (42, no operacional). El precio lo pone quien factura, no mueve kardex,
--     y el ingreso va a la cuenta del concepto.
--
-- `cuenta_id` guarda la cuenta de ingreso que usó la línea de concepto, para
-- trazabilidad: si mañana el concepto cambia de cuenta, la nota crédito de
-- esta factura sigue reversando la cuenta a la que entró. Mismo criterio que
-- `compra_documento_linea.cuenta_id` (0060).
--
-- Las cotizaciones siguen siendo solo de producto: lo valida el servicio.

ALTER TABLE venta_documento_linea
  ALTER COLUMN producto_id DROP NOT NULL,
  ADD COLUMN concepto_id uuid,
  ADD COLUMN cuenta_id uuid,
  ADD COLUMN detalle text;

ALTER TABLE venta_documento_linea
  ADD CONSTRAINT fk_venta_linea_concepto
    FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_venta_linea_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  -- De producto o de concepto: una de las dos, nunca ambas ni ninguna. La de
  -- concepto dice qué fue y a qué cuenta entró.
  ADD CONSTRAINT ck_venta_linea_producto_o_concepto CHECK (
    (producto_id IS NOT NULL AND concepto_id IS NULL)
    OR (
      producto_id IS NULL AND concepto_id IS NOT NULL AND cuenta_id IS NOT NULL
      AND length(btrim(coalesce(detalle, ''))) > 0
    )
  );

DROP INDEX IF EXISTS ix_linea_producto;
CREATE INDEX ix_linea_producto ON venta_documento_linea (producto_id)
  WHERE producto_id IS NOT NULL;
CREATE INDEX ix_venta_linea_concepto ON venta_documento_linea (concepto_id)
  WHERE concepto_id IS NOT NULL;
