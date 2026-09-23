-- 0066 — La huella del documento soporte.
--
-- Tanda 2 del diseño de María (`docs/planes/maria.md` §11 y el prototipo
-- `docs/asistente-ia-diseno/Trazabilidad.dc.html`): la trazabilidad de un
-- asiento muestra el documento del que salió con su huella sha256. La huella
-- es lo que permite decir, años después, que el archivo que se ve es el mismo
-- que se leyó: el nombre se puede cambiar y el contenido no, sin que cambie la
-- huella.
--
-- Se calcula al leer —el archivo ya está en memoria— y, para las lecturas de
-- antes de esta migración, la primera vez que alguien mira la trazabilidad.

ALTER TABLE documento_leido
  ADD COLUMN huella_sha256 char(64)
    CHECK (huella_sha256 IS NULL OR huella_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN documento_leido.huella_sha256 IS
  'El sha256 del archivo tal como esta en el bucket, en hexadecimal. Prueba que el documento soporte que se muestra es el mismo que se leyo. NULL hasta que se calcula.';
