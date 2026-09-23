-- 0060 — Una línea de compra puede ser un gasto, no solo un producto.
--
-- Hasta ahora toda línea exigía `producto_id`, así que un arriendo, el
-- internet, unos honorarios o una asesoría **no tenían dónde ir**: son la
-- factura que más llega y la única que no se podía registrar.
--
-- El cambio es una idea sola: **la línea guarda contra qué cuenta se debitó**.
--
--   - Si es un producto, esa cuenta es la de inventario del producto.
--   - Si es un gasto, es la que eligió quien registra.
--
-- Guardarla siempre —y no solo en las de gasto— tiene dos ventajas sobre
-- deducirla: la nota crédito no tiene que volver a preguntarle al producto
-- cuál era (hoy lo hace, y con una línea de gasto se caería buscando un
-- producto nulo), y el libro puede decir contra qué cuenta fue cada renglón
-- sin reconstruirlo.

ALTER TABLE compra_documento_linea
  ADD COLUMN IF NOT EXISTS cuenta_id uuid,
  -- Qué se compró, cuando no es un producto del catálogo: «Arriendo de
  -- septiembre», «Internet fibra 200 megas». En las de producto sobra: el
  -- nombre del producto ya lo dice.
  ADD COLUMN IF NOT EXISTS detalle text;

-- -----------------------------------------------------------------------------
-- Lo que ya está registrado: la cuenta de inventario de su producto
-- -----------------------------------------------------------------------------
-- Es exactamente la que se debitó cuando se registró la compra, y sigue
-- siendo la misma: `cuenta_inventario_id` de un producto **no se edita**
-- (`EditarProductoDto` no la acepta, a propósito). Así que esto no reescribe
-- historia: la hace explícita.
--
-- Hay que sortear `tg_compra_linea_inmutable`, que prohíbe todo `UPDATE`
-- sobre estas filas. El trigger está bien y se queda: una línea registrada no
-- se edita. Lo que pasa acá es otra cosa —agregarle a una fila vieja un dato
-- que siempre estuvo implícito— y por eso se apaga **solo dentro de esta
-- transacción**, con el mismo recurso que usa `scripts/limpiar-pruebas.js`.
SET LOCAL session_replication_role = 'replica';

UPDATE compra_documento_linea l
   SET cuenta_id = p.cuenta_inventario_id
  FROM producto p
 WHERE p.id = l.producto_id
   AND l.cuenta_id IS NULL;

SET LOCAL session_replication_role = 'origin';

ALTER TABLE compra_documento_linea
  ALTER COLUMN cuenta_id SET NOT NULL;

ALTER TABLE compra_documento_linea
  ADD CONSTRAINT fk_compra_linea_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- El producto pasa a ser opcional
-- -----------------------------------------------------------------------------
ALTER TABLE compra_documento_linea
  ALTER COLUMN producto_id DROP NOT NULL;

-- Sin producto hace falta el detalle: una línea que dice «519530 · 500.000» y
-- nada más obliga a abrir la factura en papel para saber qué fue.
ALTER TABLE compra_documento_linea
  ADD CONSTRAINT ck_compra_linea_gasto_con_detalle CHECK (
    producto_id IS NOT NULL OR length(btrim(coalesce(detalle, ''))) > 0
  );

-- El índice de producto se vuelve parcial: las de gasto no lo usan.
DROP INDEX IF EXISTS ix_compra_linea_producto;
CREATE INDEX ix_compra_linea_producto
  ON compra_documento_linea (producto_id)
  WHERE producto_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_compra_linea_cuenta
  ON compra_documento_linea (cuenta_id);

-- Los permisos no hacen falta: el `GRANT` de la 0031 es sobre la tabla
-- entera, no columna por columna, así que las dos nuevas quedan cubiertas.

COMMENT ON COLUMN compra_documento_linea.cuenta_id IS
  'La cuenta que se debitó: la de inventario del producto, o la del gasto.';
COMMENT ON COLUMN compra_documento_linea.detalle IS
  'Qué se compró, cuando no es un producto. Obligatorio en las de gasto.';
