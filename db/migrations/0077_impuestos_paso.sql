-- =============================================================================
-- 0077 — Configuración: el paso «Impuestos»
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 0 (§0.7, R-D10 y R-D11).
--
-- Lo tributario sale de «Situación legal» a un paso propio. Dos datos nuevos:
--
-- 1. `empresa_ica_municipio`: el ICA **por cada municipio donde hay sede**. Hasta
--    hoy se preguntaba una sola vez, por la sede principal, y una empresa con
--    sedes en otros municipios no tenía dónde decirlo. Cada respuesta tiene
--    vigencia, igual que el resto de la situación legal: cambiarla no pisa la
--    anterior. La tarifa, mientras la ley de ICA no esté cargada (Fase 3), es
--    **provisional** y así se muestra (R-D11).
-- 2. `empresa.impuestos_confirmado_en`: cuándo alguien miró el resumen «Lo que
--    esto significa para vos» y dijo «Todo correcto». Un «No» a ser gran
--    contribuyente no deja rastro en la casilla 53 (es la ausencia de un
--    código): la confirmación es lo que distingue «dijo que no» de «nadie
--    contestó».
--
-- Las empresas ya configuradas no vuelven a contestar: su «agente de ICA» pasa
-- al municipio de la sede principal con la tarifa que ya tenían, y si ya
-- tenían declarado el IVA el paso queda confirmado. Si les falta el ICA de
-- otra sede, el paso queda pendiente y el Inicio lo dice.

ALTER TABLE empresa ADD COLUMN impuestos_confirmado_en timestamptz;

COMMENT ON COLUMN empresa.impuestos_confirmado_en IS
  'Cuándo se confirmó el resumen del paso Impuestos. NULL: nadie lo confirmó todavía.';

CREATE TABLE empresa_ica_municipio (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                  uuid        NOT NULL REFERENCES empresa (id),
  municipio_codigo            char(5)     NOT NULL REFERENCES municipio (codigo),
  -- Lo decide el acuerdo o la resolución del municipio, no el RUT.
  es_agente_retenedor         boolean     NOT NULL,
  es_autorretenedor           boolean     NOT NULL DEFAULT false,
  -- Por mil. Provisional hasta que la ley de ICA del municipio esté cargada.
  tarifa_provisional_por_mil  numeric(6,3) CHECK (tarifa_provisional_por_mil IS NULL
                                OR (tarifa_provisional_por_mil >= 0 AND tarifa_provisional_por_mil <= 30)),
  fuente                      text        NOT NULL DEFAULT 'MANUAL'
                                CHECK (fuente IN ('MANUAL', 'IA', 'MIGRACION')),
  fecha_inicio                date        NOT NULL,
  fecha_fin                   date,
  creado_en                   timestamptz NOT NULL DEFAULT now(),
  creado_por                  uuid,
  CONSTRAINT ck_ica_municipio_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

-- Una sola respuesta vigente por municipio.
CREATE UNIQUE INDEX ux_ica_municipio_vigente
  ON empresa_ica_municipio (empresa_id, municipio_codigo) WHERE fecha_fin IS NULL;

ALTER TABLE empresa_ica_municipio ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_ica_municipio FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_empresa_ica_municipio_aislada ON empresa_ica_municipio
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE ON empresa_ica_municipio TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- Empresas ya configuradas
-- -----------------------------------------------------------------------------
INSERT INTO empresa_ica_municipio
  (empresa_id, municipio_codigo, es_agente_retenedor, tarifa_provisional_por_mil,
   fuente, fecha_inicio)
SELECT s.empresa_id,
       s.municipio_codigo,
       r.id IS NOT NULL,
       a.tarifa_ica_por_mil,
       'MIGRACION',
       coalesce(r.fecha_inicio, current_date)
  FROM empresa_sede s
  LEFT JOIN empresa_regimen_tributario r
         ON r.empresa_id = s.empresa_id
        AND r.tipo_regimen = 'AGENTE_RETENEDOR_ICA'
        AND r.fecha_fin IS NULL
  LEFT JOIN empresa_actividad_economica a
         ON a.empresa_id = s.empresa_id
        AND a.es_principal
        AND a.fecha_fin IS NULL
 WHERE s.es_principal AND s.activo;

UPDATE empresa e
   SET impuestos_confirmado_en = now()
 WHERE EXISTS (
         SELECT 1 FROM empresa_regimen_tributario r
          WHERE r.empresa_id = e.id
            AND r.tipo_regimen IN ('RESPONSABLE_IVA', 'NO_RESPONSABLE_IVA')
            AND r.fecha_fin IS NULL);

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0077', 'PASO_IMPUESTOS',
       jsonb_build_object(
         'municipios_migrados', (SELECT count(*) FROM empresa_ica_municipio),
         'empresas_confirmadas', (SELECT count(*) FROM empresa WHERE impuestos_confirmado_en IS NOT NULL),
         'empresas', (SELECT count(*) FROM empresa));
