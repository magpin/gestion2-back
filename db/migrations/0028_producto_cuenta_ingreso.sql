-- =============================================================================
-- 0028_producto_cuenta_ingreso — la otra cuenta que Ventas necesita del producto
-- =============================================================================
-- `0026` agregó `cuenta_costo_venta_id` (el débito cuando se vende). Faltaba
-- su pareja: `cuenta_ingreso_id` — el crédito. `docs/planes/ventas-backend.md`
-- ya decía "crédito cuenta_ingreso DEL PRODUCTO" al describir el asiento de
-- una factura, pero la migración 0026 nunca la agregó. Se corrige acá, mismo
-- patrón exacto que su pareja: nullable, FK compuesta, editable (no ancla
-- ningún movimiento de kardex ya escrito).
--
-- Candidatas típicas (docs/referencia/preactivacion-cuentas-comercio.md):
-- 413504 comercio al por mayor y al por menor, 415505 servicios.

ALTER TABLE producto ADD COLUMN cuenta_ingreso_id uuid;

ALTER TABLE producto ADD CONSTRAINT fk_producto_cuenta_ingreso
  FOREIGN KEY (cuenta_ingreso_id, empresa_id)
  REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT;

COMMENT ON COLUMN producto.cuenta_ingreso_id IS
  'La cuenta de ingreso (413504/415505 según el giro) que se acredita cuando este producto se vende. Nula en productos creados antes del módulo Ventas: se exige recién al intentar venderlos, no al crearlos — mismo criterio que cuenta_costo_venta_id.';
