-- 0042 — La imagen del producto.
--
-- Se guarda la **llave del objeto** dentro del bucket, no la URL: la URL lleva
-- el host y la firma, cambia con el entorno y caduca. Guardarla ataría la base
-- a un servidor concreto y dejaría filas apuntando a direcciones muertas el día
-- que el bucket se mueva.
--
-- Una imagen por producto (decisión 6 del plan). El día que hagan falta varias,
-- esto se convierte en tabla y esta columna pasa a ser "la principal".

ALTER TABLE producto ADD COLUMN imagen_clave text
  CHECK (imagen_clave IS NULL OR length(btrim(imagen_clave)) > 0);

COMMENT ON COLUMN producto.imagen_clave IS
  'La llave del objeto en el bucket (p. ej. productos/<uuid>.jpg). La URL se firma al leer, no se guarda.';
