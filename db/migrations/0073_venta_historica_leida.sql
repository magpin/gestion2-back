-- =============================================================================
-- 0073 — Que María lea las ventas del sistema anterior
-- =============================================================================
--
-- Fase 11 de `docs/planes/maria-facturas-y-errores.md`. Un archivo con
-- facturas de venta que la empresa emitió **antes** de usar el sistema —en el
-- software anterior— ya no se rechaza: María lo lee, dice cuáles ya están y
-- propone cargar las demás como históricas (las de la 0065).
--
-- Nada más cambia en el esquema: lo leído vive en `documento_leido.extraido`
-- como el resto de las lecturas, y lo cargado es una `venta_documento` con
-- `historica = true`, por la misma puerta que el Excel.

-- ── 1. El tipo ───────────────────────────────────────────────────────────────
ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_tipo_check;
ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_tipo_check
  CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN', 'FACTURA_COMPRA',
                  'PEDIDO_VENTA', 'VENTA_HISTORICA'));

-- ── 2. Cuántos se pueden leer a la vez ───────────────────────────────────────
-- Como las facturas y los pedidos: el histórico llega en varios archivos, y
-- subir el segundo mientras corre el primero es la intención.
DROP INDEX uq_documento_leido_en_curso;
CREATE UNIQUE INDEX uq_documento_leido_en_curso
  ON documento_leido (empresa_id, tipo)
  WHERE estado IN ('EN_COLA', 'LEYENDO')
    AND tipo NOT IN ('FACTURA_COMPRA', 'PEDIDO_VENTA', 'VENTA_HISTORICA');
