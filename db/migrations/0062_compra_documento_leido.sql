-- 0062 — De qué documento leído salió una compra.
--
-- Fase 6 de `docs/planes/maria-facturas-y-errores.md`. Lo destapó la pantalla:
-- la lista de facturas leídas mostraba tres filas idénticas de la misma cuenta
-- de cobro —«me faltan 2 datos»— y **una de ellas ya era una compra
-- registrada**. Nada lo decía, y el botón de registrar seguía ofreciéndose.
--
-- Mismo criterio que `asiento.propuesta_id` (0058): **el resultado apunta al
-- origen**, no al revés. Una compra tiene a lo sumo un documento del que salió;
-- un documento leído puede terminar en ninguna compra —si nadie lo confirma— y
-- nunca en dos, porque la segunda choca con el número del proveedor.
--
-- Va en el INSERT y no en un UPDATE posterior: una compra registrada no se
-- reescribe, y de todas formas se sabe al crearla.

ALTER TABLE compra_documento
  ADD COLUMN documento_leido_id uuid REFERENCES documento_leido (id) ON DELETE SET NULL;

COMMENT ON COLUMN compra_documento.documento_leido_id IS
  'El documento que el asistente leyo y del que salio esta compra, cuando una persona confirmo esa lectura. NULL en una compra digitada a mano. ON DELETE SET NULL: borrar el historial de lecturas no puede borrar una compra.';

-- Para «¿esta lectura ya se registró?», que es la pregunta de la pantalla.
-- Parcial: la enorme mayoria de las compras se digitan y tienen NULL aca.
CREATE INDEX ix_compra_documento_leido
  ON compra_documento (documento_leido_id)
  WHERE documento_leido_id IS NOT NULL;

-- El permiso de escritura nombra las columnas, asi que hay que regrabarlo o la
-- API no puede insertar la nueva. Mismo problema que encontro la 0059.
GRANT INSERT ON compra_documento TO gestion_app, gestion_provision;
