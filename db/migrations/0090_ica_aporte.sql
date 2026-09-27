-- =============================================================================
-- 0090 — Qué aportó cada documento al acumulado de ICA del período
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.4).
--
-- Medellín (y los municipios que acumulan) suma las compras pequeñas del mismo
-- proveedor en el período: juntas pueden pasar la base. `ica_acumulado_periodo`
-- (0083) guardaba solo el total, así que una nota crédito o una anulación no
-- lo bajaba: no se sabía cuánto había aportado esa compra.
--
-- Cada aporte queda como una fila de solo inserción: la compra suma; su nota
-- crédito resta la proporción; anular resta lo que quede. `compra_id` es la
-- compra a la que pertenece el aporte (en una nota, la compra que corrige),
-- para saber qué queda de ella. El total del período se sigue manteniendo en
-- `ica_acumulado_periodo`, en la misma transacción.

CREATE TABLE ica_acumulado_aporte (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id),
  compra_id           uuid          NOT NULL,
  documento_id        uuid          NOT NULL,
  tercero_id          uuid          NOT NULL,
  municipio_codigo    char(5)       NOT NULL,
  anio                smallint      NOT NULL,
  periodo             smallint      NOT NULL,
  base                numeric(18,2) NOT NULL,
  retenido            numeric(18,2) NOT NULL,
  creado_en           timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX ix_ica_aporte_compra ON ica_acumulado_aporte (empresa_id, compra_id);
CREATE INDEX ix_ica_aporte_documento ON ica_acumulado_aporte (empresa_id, documento_id);

ALTER TABLE ica_acumulado_aporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE ica_acumulado_aporte FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_ica_aporte_aislado ON ica_acumulado_aporte
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON ica_acumulado_aporte TO gestion_app, gestion_provision;
