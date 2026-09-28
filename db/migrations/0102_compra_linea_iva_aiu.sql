-- =============================================================================
-- 0102 — Compras: el IVA de los servicios con AIU se liquida sobre el AIU
-- =============================================================================
--
-- Bug #16 de la revisión del 27-09 (docs/planes/prueba-qa-motor-retenciones.md).
--
-- Aseo, vigilancia autorizada, servicios temporales de empleo y cooperativas
-- de trabajo asociado liquidan el IVA sobre el AIU, que no puede ser inferior
-- al 10 % del valor del contrato (art. 462-1 ET). Hasta ahora el renglón solo
-- sabía liquidar el IVA sobre su subtotal, y `ck_compra_linea_iva` lo exigía:
-- un servicio de aseo de $10.000.000 con AIU de $1.200.000 salía con
-- $1.900.000 de IVA en vez de $228.000, y la ReteIVA crecía con él.
--
-- `iva_base` es la base del IVA del renglón cuando no es su subtotal: el AIU
-- (ya con el piso del 10 %). NULL es lo de siempre: el IVA va sobre el
-- subtotal.

ALTER TABLE compra_documento_linea
  ADD COLUMN iva_base numeric(18,2),
  ADD CONSTRAINT ck_compra_linea_iva_base
    CHECK (iva_base IS NULL OR (iva_base >= 0 AND iva_base <= subtotal)),
  DROP CONSTRAINT ck_compra_linea_iva,
  ADD CONSTRAINT ck_compra_linea_iva
    CHECK (iva_valor = round(coalesce(iva_base, subtotal) * iva_tarifa / 100, 2));

COMMENT ON COLUMN compra_documento_linea.iva_base IS
  'Base del IVA cuando no es el subtotal: el AIU de aseo, vigilancia, temporales y cooperativas (art. 462-1 ET, mínimo 10 %). NULL = el subtotal.';
