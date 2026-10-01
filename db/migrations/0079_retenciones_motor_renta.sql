-- =============================================================================
-- 0079 — Motor de retenciones: retención en la fuente (renta) en compras
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 1 (§1.2).
--
-- 1. `retencion_calculada`: cada retención que el motor calcula, con su
--    explicación completa (guardas, concepto y de dónde salió, base, mínimo,
--    tarifa y norma). **Solo se inserta**: una corrección es una fila nueva que
--    anula a la anterior (`anula_a`), nunca un UPDATE. Es lo que permite
--    responder «¿por qué le retuviste esto?» años después.
-- 2. `retencion_mapeo_concepto`: lo que una persona confirmó o corrigió
--    («a Omaira, por “arriendo”, es arrendamiento de inmuebles»). La próxima
--    vez es la fuente 1: «La vi clara».
-- 3. `retencion_acumulado`: la base del año por tercero y concepto. Solo la
--    usan los honorarios y comisiones de persona natural (umbral de 3.300 UVT).
-- 4. `compra_retencion` y `compra_documento` guardan con qué concepto de la ley
--    y qué decisión se registró la compra.

-- -----------------------------------------------------------------------------
-- 1. retencion_calculada
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_calculada (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid          NOT NULL REFERENCES empresa (id),
  documento_tipo        text          NOT NULL CHECK (documento_tipo IN
                          ('COMPRA', 'NOTA_CREDITO_COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA')),
  documento_id          uuid          NOT NULL,
  -- Renta se calcula por concepto dentro del documento; los renglones que lo
  -- forman van en la explicación.
  documento_linea_id    uuid,
  tercero_id            uuid          NOT NULL,
  impuesto              text          NOT NULL CHECK (impuesto IN ('RENTA', 'IVA', 'ICA')),
  concepto_nacional_id  uuid          NOT NULL REFERENCES retencion_concepto_nacional (id),
  fecha_causacion       date          NOT NULL,
  base                  numeric(18,2) NOT NULL,
  tarifa_nominal        numeric(8,6)  NOT NULL,
  factor_zomac          numeric(5,4)  NOT NULL DEFAULT 1,
  tarifa_efectiva       numeric(8,6)  NOT NULL,
  valor                 numeric(18,2) NOT NULL,
  municipio_codigo      char(5),
  es_autorretencion     boolean       NOT NULL DEFAULT false,
  tarifa_id             uuid          REFERENCES retencion_tarifa (id),
  uvt_valor             numeric(12,2),
  norma_aplicada        text          NOT NULL,
  origen_clasificacion  text          NOT NULL CHECK (origen_clasificacion IN
                          ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA', 'MANUAL')),
  explicacion           jsonb         NOT NULL,
  estado                text          NOT NULL CHECK (estado IN
                          ('PROPUESTA', 'CONFIRMADA', 'ANULADA', 'REVISION')),
  anula_a               uuid          REFERENCES retencion_calculada (id),
  motor_version         text          NOT NULL,
  creado_en             timestamptz   NOT NULL DEFAULT now(),
  creado_por            uuid
);

CREATE INDEX ix_retencion_calculada_documento
  ON retencion_calculada (empresa_id, documento_tipo, documento_id);
CREATE INDEX ix_retencion_calculada_tercero
  ON retencion_calculada (empresa_id, tercero_id, fecha_causacion);

ALTER TABLE retencion_calculada ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_calculada FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_calculada_aislada ON retencion_calculada
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- Solo inserción: sin UPDATE ni DELETE para nadie de la aplicación.
GRANT SELECT, INSERT ON retencion_calculada TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 2. retencion_mapeo_concepto — lo que una persona confirmó
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_mapeo_concepto (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid          NOT NULL REFERENCES empresa (id),
  -- NULL = vale para cualquier proveedor.
  tercero_id            uuid,
  producto_id           uuid,
  -- El renglón normalizado (minúsculas, sin tildes ni números): «arriendo local».
  llave_renglon         text,
  ciiu                  varchar(8),
  concepto_nacional_id  uuid          NOT NULL REFERENCES retencion_concepto_nacional (id),
  -- CONFIRMADO: aceptó lo que el sistema dedujo. CORREGIDO: eligió otro.
  origen                text          NOT NULL CHECK (origen IN ('CONFIRMADO', 'CORREGIDO')),
  veces                 int           NOT NULL DEFAULT 1,
  confirmado_por        uuid,
  creado_en             timestamptz   NOT NULL DEFAULT now(),
  actualizado_en        timestamptz   NOT NULL DEFAULT now(),
  activo                boolean       NOT NULL DEFAULT true,
  CONSTRAINT ck_mapeo_con_llave CHECK (producto_id IS NOT NULL OR llave_renglon IS NOT NULL)
);

-- Una sola respuesta activa por proveedor y renglón (o producto).
CREATE UNIQUE INDEX ux_mapeo_concepto_activo
  ON retencion_mapeo_concepto (
       empresa_id,
       COALESCE(tercero_id, '00000000-0000-0000-0000-000000000000'::uuid),
       COALESCE(producto_id, '00000000-0000-0000-0000-000000000000'::uuid),
       COALESCE(llave_renglon, ''))
  WHERE activo;

ALTER TABLE retencion_mapeo_concepto ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_mapeo_concepto FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_mapeo_aislado ON retencion_mapeo_concepto
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE ON retencion_mapeo_concepto TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 3. retencion_acumulado — honorarios y comisiones de persona natural
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_acumulado (
  empresa_id            uuid          NOT NULL REFERENCES empresa (id),
  tercero_id            uuid          NOT NULL,
  concepto_nacional_id  uuid          NOT NULL REFERENCES retencion_concepto_nacional (id),
  anio                  int           NOT NULL,
  base_acumulada        numeric(18,2) NOT NULL DEFAULT 0,
  actualizado_en        timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, tercero_id, concepto_nacional_id, anio)
);

ALTER TABLE retencion_acumulado ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_acumulado FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_acumulado_aislado ON retencion_acumulado
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE ON retencion_acumulado TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 4. compra_retencion y compra_documento
-- -----------------------------------------------------------------------------
ALTER TABLE compra_retencion
  ADD COLUMN tipo                   text CHECK (tipo IS NULL OR tipo IN ('RENTA', 'IVA', 'ICA')),
  ADD COLUMN concepto_nacional_id   uuid REFERENCES retencion_concepto_nacional (id),
  ADD COLUMN tarifa                 numeric(8,6),
  ADD COLUMN retencion_calculada_id uuid REFERENCES retencion_calculada (id);

-- Las filas viejas son inmutables (0031); completar su tipo no las cambia, así
-- que el trigger se suspende solo para esto. Eran de renta salvo las que el
-- catálogo guardó con código de IVA o ICA.
ALTER TABLE compra_retencion DISABLE TRIGGER tg_compra_retencion_inmutable;
UPDATE compra_retencion
   SET tipo = CASE
                WHEN upper(concepto) LIKE 'RETEIVA%' OR upper(concepto) = 'IVA' THEN 'IVA'
                WHEN upper(concepto) LIKE 'RETEICA%' OR upper(concepto) = 'ICA' THEN 'ICA'
                ELSE 'RENTA'
              END;
ALTER TABLE compra_retencion ENABLE TRIGGER tg_compra_retencion_inmutable;

ALTER TABLE compra_documento
  ADD COLUMN retencion_decision text CHECK (retencion_decision IS NULL OR retencion_decision IN
    ('CALCULADA', 'BAJO_BASE', 'NO_SUJETO', 'DECIDIDO_SIN', 'MANUAL')),
  ADD COLUMN retencion_motivo   text;

COMMENT ON COLUMN compra_documento.retencion_decision IS
  'Qué decidió el motor de renta: CALCULADA, BAJO_BASE (no llegó al mínimo), NO_SUJETO (una guarda: no agente, SIMPLE, autorretenedor…), DECIDIDO_SIN (una persona dijo que no, con motivo) o MANUAL (anterior al motor).';
