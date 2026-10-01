-- =============================================================================
-- 0082 — ReteIVA: el IVA que asume la empresa
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 2.
--
-- En un servicio del exterior el proveedor no factura IVA: lo asume la
-- empresa y lo retiene al 100 % (art. 437-2 num. 3). Esa retención **no baja
-- lo que se le paga al proveedor**: el asiento debita el IVA descontable y
-- acredita la 2367, y la cuenta por pagar queda igual. `asumida` lo marca, para
-- que la nota crédito lo reverse del mismo modo y no le reste al proveedor.
ALTER TABLE compra_retencion
  ADD COLUMN asumida boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN compra_retencion.asumida IS
  'IVA que asume la empresa (servicios del exterior): no descuenta del neto al proveedor.';
