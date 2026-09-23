-- 0064 — Que María lea el pedido de un cliente y arme la factura de venta.
--
-- Fase 8 de `docs/planes/maria-facturas-y-errores.md`. Es la hermana de la
-- 0061 y la 0062 —que hicieron lo mismo para las facturas de compra—, con una
-- diferencia de fondo: **una factura de venta no tiene borrador**. Nace
-- emitida, con su consecutivo de la DIAN y su asiento (`ck_venta_fiscal`). Así
-- que el borrador vive donde ya vivía el de la compra, en
-- `documento_leido.extraido`, y la factura existe recién cuando una persona la
-- emite.

-- ── 1. El tipo ───────────────────────────────────────────────────────────────
ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_tipo_check;
ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_tipo_check
  CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN', 'FACTURA_COMPRA', 'PEDIDO_VENTA'));

-- ── 2. Cuántos se pueden leer a la vez ───────────────────────────────────────
-- Lo mismo que la 0061 dijo de las facturas: llegan varios pedidos el mismo
-- día, y subir el segundo mientras corre el primero es la intención.
DROP INDEX uq_documento_leido_en_curso;
CREATE UNIQUE INDEX uq_documento_leido_en_curso
  ON documento_leido (empresa_id, tipo)
  WHERE estado IN ('EN_COLA', 'LEYENDO') AND tipo NOT IN ('FACTURA_COMPRA', 'PEDIDO_VENTA');

-- ── 3. De qué pedido salió una factura ───────────────────────────────────────
-- Mismo criterio que `compra_documento.documento_leido_id` (0062): el
-- resultado apunta al origen, va en el INSERT, y lo pone el servidor.
ALTER TABLE venta_documento
  ADD COLUMN documento_leido_id uuid REFERENCES documento_leido (id) ON DELETE SET NULL;

COMMENT ON COLUMN venta_documento.documento_leido_id IS
  'El pedido del cliente que el asistente leyo y del que salio esta factura, cuando una persona la emitio desde esa lectura. NULL en una factura armada a mano.';

-- **Un pedido se factura una vez.** En una compra lo garantizaba el número del
-- proveedor; en una venta el número lo ponemos nosotros, así que nada impedía
-- emitir dos facturas del mismo pedido con dos clics. Una anulada libera el
-- pedido: si se anuló, volver a facturarlo es lo que se quiere.
CREATE UNIQUE INDEX uq_venta_documento_leido
  ON venta_documento (documento_leido_id)
  WHERE documento_leido_id IS NOT NULL AND estado <> 'ANULADA';
