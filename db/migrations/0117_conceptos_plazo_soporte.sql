-- Conceptos con sugerencias, plazo por tercero y documento soporte
-- (Fase 7 de docs/planes/plan-pantallas-complementarias.md).
--
-- 1. `concepto_movimiento`: lo que el concepto sugiere al motor (PC23). Son
--    sugerencias: el motor de retenciones sigue decidiendo por renglón.
--    · `iva_compra`: si el IVA de lo comprado con este concepto se descuenta.
--    · `retencion_sugerida`: el concepto de retención de renta (código de
--      `retencion_concepto_nacional`) que se propone.
--    · `aplica_reteica`: si se le practica ReteICA. Sin tarifa: la tarifa
--      depende del municipio y la resuelve el motor (E20).
--    · `deducible`: si se puede restar en la renta (con factura o soporte).
--
-- 2. `tercero.dias_plazo_*`: el plazo habitual como cliente y como proveedor
--    (PC25). La factura y la compra a crédito lo proponen para el vence.
--
-- 3. `compra_documento`:
--    · `clase_documento`: la compra sigue siendo una factura para pagos,
--      IVA y retenciones; esto dice si la emitió el proveedor (factura
--      electrónica) o la empresa porque el vendedor no está obligado a
--      facturar (documento soporte), con su consecutivo de la resolución.
--    · `transmision`: el soporte nace SIN_TRANSMITIR; no hay módulo DIAN (PC2).
--    · `cufe`: el de la factura electrónica del proveedor, como dato.

ALTER TABLE concepto_movimiento
  ADD COLUMN iva_compra text
    CHECK (iva_compra IS NULL OR iva_compra IN ('DESCONTABLE', 'NO_DESCONTABLE', 'SIN_IVA')),
  ADD COLUMN retencion_sugerida text,
  ADD COLUMN aplica_reteica boolean NOT NULL DEFAULT false,
  ADD COLUMN deducible boolean NOT NULL DEFAULT true;

ALTER TABLE tercero
  ADD COLUMN dias_plazo_cliente smallint
    CHECK (dias_plazo_cliente IS NULL OR dias_plazo_cliente BETWEEN 0 AND 365),
  ADD COLUMN dias_plazo_proveedor smallint
    CHECK (dias_plazo_proveedor IS NULL OR dias_plazo_proveedor BETWEEN 0 AND 365);

ALTER TABLE compra_documento
  ADD COLUMN clase_documento text NOT NULL DEFAULT 'FACTURA_ELECTRONICA'
    CHECK (clase_documento IN ('FACTURA_ELECTRONICA', 'DOCUMENTO_SOPORTE')),
  ADD COLUMN transmision text
    CHECK (transmision IS NULL OR transmision IN ('SIN_TRANSMITIR', 'TRANSMITIDO', 'ACEPTADO')),
  ADD COLUMN cufe text CHECK (cufe IS NULL OR length(btrim(cufe)) BETWEEN 20 AND 200),
  ADD CONSTRAINT ck_compra_soporte CHECK (
    (clase_documento = 'DOCUMENTO_SOPORTE') = (transmision IS NOT NULL)
    AND (clase_documento = 'FACTURA_ELECTRONICA' OR tipo = 'FACTURA'));
