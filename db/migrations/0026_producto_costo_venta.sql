-- =============================================================================
-- 0026_producto_costo_venta — la cuenta de costo, y un tipo nuevo de salida
-- =============================================================================
-- Primer ajuste que le pide `ventas` (módulo 4 de la secuencia) a `inventario`,
-- ya construido. Dos cambios chicos, no un rediseño:
--
--   1. `producto.cuenta_costo_venta_id` — la cuenta (6135/6145 según el giro)
--      contra la que se debita el costo cuando ESTE producto se vende. No vivía
--      acá porque `productos-inventario.md` decidió a propósito no adivinarla
--      antes de que Ventas existiera. Ahora existe.
--   2. `producto_movimiento.tipo` suma `'SALIDA_VENTA'` — el movimiento que
--      inserta `InventarioApi.descontarPorVenta` cuando una factura descuenta
--      existencias. `'ENTRADA_COMPRA'` NO se agrega todavía: eso lo decide
--      Compras (módulo 5) cuando le toque, mismo principio de no adivinar un
--      contrato para un consumidor que no existe.
--
-- Nullable a propósito: los productos creados antes de este corte no tienen
-- este dato, y no hay forma de adivinarlo por ellos. `VentasService` rechaza
-- vender un producto sin `cuenta_costo_venta_id` con un mensaje que lo diga,
-- no con el genérico de una FK violada.

ALTER TABLE producto ADD COLUMN cuenta_costo_venta_id uuid;

ALTER TABLE producto ADD CONSTRAINT fk_producto_cuenta_costo_venta
  FOREIGN KEY (cuenta_costo_venta_id, empresa_id)
  REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT;

COMMENT ON COLUMN producto.cuenta_costo_venta_id IS
  'La cuenta (6135/6145 según el giro) contra la que se debita el costo cuando este producto se vende. Nula en productos creados antes del módulo Ventas: se exige recién al intentar venderlos, no al crearlos.';

-- El CHECK original de `tipo` (0025) quedó sin nombre propio, a diferencia de
-- sus hermanos en la misma tabla (ck_movimiento_asiento y compañía, todos con
-- prefijo ck_). Se aprovecha este ALTER para corregir esa inconsistencia de
-- una vez: se retira el CHECK autogenerado y se reemplaza por uno nombrado.
ALTER TABLE producto_movimiento DROP CONSTRAINT producto_movimiento_tipo_check;

ALTER TABLE producto_movimiento ADD CONSTRAINT ck_movimiento_tipo
  CHECK (tipo IN ('ENTRADA_INICIAL', 'ENTRADA_AJUSTE', 'SALIDA_AJUSTE', 'SALIDA_VENTA'));
