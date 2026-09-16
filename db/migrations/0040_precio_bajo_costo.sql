-- 0040 — Quién autorizó vender por debajo del costo.
--
-- Hasta acá nada comparaba el precio de venta contra el costo: una línea podía
-- salir a 10.000 con un costo promedio de 17.961 y quedar registrada como
-- cualquier otra. Vender con pérdida a veces hace falta —liquidar mercancía
-- vieja, cerrar un negocio grande—, pero tiene que ser una decisión de alguien
-- y no un descuido.
--
-- Va como columna en la línea y no como tabla aparte: la pregunta que hay que
-- contestar es "qué líneas se vendieron bajo costo y quién las aprobó", y eso
-- es un WHERE sobre esta misma tabla. El índice parcial la hace barata sin
-- pesar en las líneas normales, que son la enorme mayoría.
--
-- `costo_unitario` ya vive en la línea, así que la pérdida no se guarda: se
-- deriva (`precio_unitario - costo_unitario`), por lo mismo que el saldo
-- efectivo del paso 11 no se guardó como columna.

ALTER TABLE venta_documento_linea
  ADD COLUMN precio_bajo_costo_autorizado_por uuid REFERENCES usuario(id);

COMMENT ON COLUMN venta_documento_linea.precio_bajo_costo_autorizado_por IS
  'Quién autorizó que esta línea saliera por debajo de su costo. NULL en una línea normal.';

CREATE INDEX ix_venta_linea_bajo_costo
  ON venta_documento_linea (empresa_id, venta_documento_id)
  WHERE precio_bajo_costo_autorizado_por IS NOT NULL;
