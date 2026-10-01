-- =============================================================================
-- 0108 — La línea de gasto de una compra lleva su concepto
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 6.
--
-- Desde la 0060 una línea sin producto se debita contra una cuenta que elige
-- quien registra. Con los conceptos (0103) se elige el concepto —«Arriendo»,
-- «Transporte, fletes y acarreos»— y la cuenta la pone el sistema. La línea
-- guarda cuál fue, igual que guarda la cuenta: así la nota crédito lo
-- reversa con el mismo concepto y la vista de Gastos suma por concepto sin
-- adivinar.
--
-- Opcional: las líneas de producto no lo llevan, y las de gasto registradas
-- antes —o por un contador que eligió la cuenta— tampoco.

ALTER TABLE compra_documento_linea ADD COLUMN concepto_id uuid;

ALTER TABLE compra_documento_linea
  ADD CONSTRAINT fk_compra_linea_concepto
    FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT;

-- Un concepto es de una línea de gasto: la de producto ya sabe a dónde va.
ALTER TABLE compra_documento_linea
  ADD CONSTRAINT ck_compra_linea_concepto_sin_producto
    CHECK (concepto_id IS NULL OR producto_id IS NULL);

CREATE INDEX ix_compra_linea_concepto ON compra_documento_linea (concepto_id)
  WHERE concepto_id IS NOT NULL;

