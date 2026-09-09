-- =============================================================================
-- 0029_conversion_cotizacion — convertir una cotización en factura
-- =============================================================================
-- `0027` ya dejó anotado en "Qué NO entra en este corte" de
-- `docs/planes/ventas-backend.md" que esto llegaría marcando la cotización
-- con un estado nuevo (`CONVERTIDA`) en el `CHECK` de `estado`. Se aprovecha
-- además para enlazarla formalmente: `documento_origen_id` y su FK compuesta
-- (`fk_venta_origen`) ya existen desde `0027` para la nota crédito → factura;
-- sirven igual de bien para factura → cotización, sin agregar columna nueva.
--
-- Tres cambios sobre `venta_documento`, ninguno sobre `venta_documento_linea`:
--
--   1. `estado` acepta `CONVERTIDA` además de `BORRADOR`/`EMITIDA`/`ANULADA`.
--   2. `ck_venta_origen` se afloja: seguía exigiendo NULL en toda FACTURA;
--      ahora permite que una FACTURA sí tenga `documento_origen_id` cuando
--      viene de convertir una cotización (queda NULL igual en una factura
--      "directa", sin cotización de por medio — no se vuelve obligatorio).
--   3. `ck_venta_estado_tipo`, nueva: ata qué estados puede tener cada tipo.
--      Sin esto, nada impedía —a nivel de motor— que una FACTURA quedara en
--      `BORRADOR` o una COTIZACION en `ANULADA`, dos cosas que ningún
--      servicio hace hoy pero que el `CHECK` de `estado` por sí solo no
--      podía prohibir al no conocer el `tipo` de la fila.

ALTER TABLE venta_documento DROP CONSTRAINT venta_documento_estado_check;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_estado CHECK (
  estado IN ('BORRADOR', 'EMITIDA', 'CONVERTIDA', 'ANULADA')
);

ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_origen;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_origen CHECK (
  (tipo = 'NOTA_CREDITO' AND documento_origen_id IS NOT NULL)
  OR (tipo = 'FACTURA')
  OR (tipo = 'COTIZACION' AND documento_origen_id IS NULL)
);

-- Solo COTIZACION llega a CONVERTIDA; solo COTIZACION se queda en BORRADOR
-- (sin usar todavía — ver el comentario de `0027`); ninguna cotización
-- llega a ANULADA (`VentaDocumentoService.anular` ya lo rechaza en código,
-- esto es el mismo candado del lado del motor).
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_estado_tipo CHECK (
  (tipo = 'COTIZACION' AND estado IN ('BORRADOR', 'EMITIDA', 'CONVERTIDA'))
  OR (tipo <> 'COTIZACION' AND estado IN ('EMITIDA', 'ANULADA'))
);

COMMENT ON COLUMN venta_documento.documento_origen_id IS
  'En NOTA_CREDITO: la factura que corrige (obligatorio). En FACTURA: la cotización de la que se convirtió, si vino de una (opcional — una factura también se crea directa). NULL siempre en COTIZACION.';
