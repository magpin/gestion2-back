-- =============================================================================
-- 0083 — ReteICA en varios municipios
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 3.
--
-- El ICA es municipal: cada municipio fija su base mínima, su tarifa y a quién
-- se le retiene. Por eso todo esto son **datos** y no lógica:
--
-- 1. La ley municipal (sin RLS, la escribe la consola de plataforma):
--    `ica_parametro` (base mínima, tarifa general, si acumula en el período),
--    `ica_tarifa` (por actividad) e `ica_matriz_agente` (quién le retiene a
--    quién). Semilla: **Medellín 2026**, lo único que la especificación trae
--    completo y validado (Yeris, 25-09-2026). Los demás municipios se cargan
--    desde la consola cuando se tengan sus acuerdos: no se inventan.
-- 2. Por empresa (con RLS): `tercero_perfil_ica` (el ICA de cada proveedor en
--    cada municipio, con vigencia) e `ica_acumulado_periodo` (Medellín acumula
--    en el bimestre: varias compras pequeñas juntas pueden pasar la base).
--    El perfil de ICA de la empresa ya existe desde la 0077
--    (`empresa_ica_municipio`).
-- 3. `compra_retencion.municipio_codigo`: una factura puede causar ICA en dos
--    municipios, así que la unicidad pasa a ser por concepto **y** municipio.

-- -----------------------------------------------------------------------------
-- 1. La ley municipal
-- -----------------------------------------------------------------------------
CREATE TABLE ica_parametro (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  municipio_codigo            char(5)      NOT NULL REFERENCES municipio (codigo),
  anio                        smallint     NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  -- NULL = sin base mínima.
  base_minima_uvt_compras     numeric(10,2) CHECK (base_minima_uvt_compras IS NULL OR base_minima_uvt_compras >= 0),
  base_minima_uvt_servicios   numeric(10,2) CHECK (base_minima_uvt_servicios IS NULL OR base_minima_uvt_servicios >= 0),
  -- Por mil. Algunos municipios retienen con una tarifa única.
  tarifa_general_por_mil      numeric(8,4)  CHECK (tarifa_general_por_mil IS NULL OR (tarifa_general_por_mil >= 0 AND tarifa_general_por_mil <= 30)),
  usa_tarifa_por_actividad    boolean      NOT NULL DEFAULT true,
  -- Medellín: las compras pequeñas del mismo proveedor en el período se suman.
  acumula_en_periodo          boolean      NOT NULL DEFAULT false,
  periodicidad                text         NOT NULL DEFAULT 'BIMESTRAL'
                                CHECK (periodicidad IN ('MENSUAL', 'BIMESTRAL', 'TRIMESTRAL', 'ANUAL')),
  acuerdo                     text         NOT NULL CHECK (length(btrim(acuerdo)) > 0),
  validado_por                text         NOT NULL,
  validado_en                 date         NOT NULL,
  creado_en                   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_ica_parametro UNIQUE (municipio_codigo, anio)
);

CREATE TABLE ica_tarifa (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  municipio_codigo  char(5)      NOT NULL REFERENCES municipio (codigo),
  anio              smallint     NOT NULL,
  codigo_actividad  varchar(20)  NOT NULL,
  -- El CIIU nacional, cuando el código local tiene equivalente.
  ciiu              varchar(8),
  descripcion       text,
  tipo              text         NOT NULL CHECK (tipo IN ('INDUSTRIAL', 'COMERCIAL', 'SERVICIOS', 'FINANCIERA')),
  tarifa_por_mil    numeric(8,4) NOT NULL,
  acuerdo           text         NOT NULL,
  validado_por      text         NOT NULL,
  validado_en       date         NOT NULL,
  CONSTRAINT uq_ica_tarifa UNIQUE (municipio_codigo, anio, codigo_actividad),
  -- Art. 342 Ley 1819/2016: 2–7 ‰ industria, 2–10 ‰ comercio y servicios. Una
  -- fuera de rango es casi siempre un error de digitación; el financiero tiene
  -- su propio régimen.
  CONSTRAINT ck_ica_tarifa_rango CHECK (
    tipo = 'FINANCIERA'
    OR (tipo = 'INDUSTRIAL' AND tarifa_por_mil BETWEEN 2 AND 7)
    OR (tipo IN ('COMERCIAL', 'SERVICIOS') AND tarifa_por_mil BETWEEN 2 AND 10))
);

CREATE INDEX ix_ica_tarifa_ciiu ON ica_tarifa (municipio_codigo, anio, ciiu);

-- Quién le retiene a quién en ese municipio. `*` vale para cualquiera. Sin
-- filas para un municipio y año, se retiene (la regla general).
CREATE TABLE ica_matriz_agente (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  municipio_codigo     char(5)      NOT NULL REFERENCES municipio (codigo),
  anio                 smallint     NOT NULL,
  perfil_pagador       text         NOT NULL,
  perfil_beneficiario  text         NOT NULL,
  retiene              boolean      NOT NULL,
  fundamento           text,
  CONSTRAINT uq_ica_matriz UNIQUE (municipio_codigo, anio, perfil_pagador, perfil_beneficiario)
);

-- La aplicación solo lee la ley; escribe la consola, con la conexión de
-- provisión. El REVOKE hace falta por los privilegios por defecto de la 0044.
GRANT SELECT ON ica_parametro, ica_tarifa, ica_matriz_agente TO gestion_app;
REVOKE INSERT, UPDATE, DELETE ON ica_parametro, ica_tarifa, ica_matriz_agente FROM gestion_app;
GRANT SELECT, INSERT, UPDATE ON ica_parametro, ica_tarifa, ica_matriz_agente TO gestion_provision;

-- Medellín 2026 (especificación §4.5): base única de 15 UVT, tarifa general de
-- retención del 2 por mil, acumula en el bimestre.
INSERT INTO ica_parametro
  (municipio_codigo, anio, base_minima_uvt_compras, base_minima_uvt_servicios,
   tarifa_general_por_mil, usa_tarifa_por_actividad, acumula_en_periodo,
   periodicidad, acuerdo, validado_por, validado_en)
SELECT '05001', 2026, 15, 15, 2.0, false, true, 'BIMESTRAL',
       'Acuerdo 093 de 2023 — Distrito de Medellín, arts. 81 y 89', 'Yeris', '2026-09-25'
 WHERE EXISTS (SELECT 1 FROM municipio WHERE codigo = '05001');

-- -----------------------------------------------------------------------------
-- 2. Por empresa
-- -----------------------------------------------------------------------------
CREATE TABLE tercero_perfil_ica (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id              uuid        NOT NULL REFERENCES empresa (id),
  tercero_id              uuid        NOT NULL,
  municipio_codigo        char(5)     NOT NULL REFERENCES municipio (codigo),
  ica_regimen             text        NOT NULL DEFAULT 'COMUN'
                            CHECK (ica_regimen IN ('COMUN', 'PREFERENCIAL', 'NO_CONTRIBUYENTE')),
  es_agente_ret_ica       boolean     NOT NULL DEFAULT false,
  es_autorretenedor_ica   boolean     NOT NULL DEFAULT false,
  codigo_actividad_local  varchar(20),
  resolucion              text,
  vigencia_desde          date        NOT NULL,
  vigencia_hasta          date,
  creado_en               timestamptz NOT NULL DEFAULT now(),
  creado_por              uuid,
  CONSTRAINT fk_perfil_ica_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id),
  CONSTRAINT ck_perfil_ica_vigencia CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT ex_perfil_ica_sin_solape EXCLUDE USING gist (
    empresa_id WITH =,
    tercero_id WITH =,
    municipio_codigo WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);

ALTER TABLE tercero_perfil_ica ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero_perfil_ica FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_tercero_perfil_ica_aislado ON tercero_perfil_ica
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE ON tercero_perfil_ica TO gestion_app, gestion_provision;

CREATE TABLE ica_acumulado_periodo (
  empresa_id          uuid          NOT NULL REFERENCES empresa (id),
  tercero_id          uuid          NOT NULL,
  municipio_codigo    char(5)       NOT NULL,
  anio                smallint      NOT NULL,
  -- El número del período dentro del año: bimestre 1..6, mes 1..12…
  periodo             smallint      NOT NULL,
  base_acumulada      numeric(18,2) NOT NULL DEFAULT 0,
  retenido_acumulado  numeric(18,2) NOT NULL DEFAULT 0,
  actualizado_en      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, tercero_id, municipio_codigo, anio, periodo)
);

ALTER TABLE ica_acumulado_periodo ENABLE ROW LEVEL SECURITY;
ALTER TABLE ica_acumulado_periodo FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_ica_acumulado_aislado ON ica_acumulado_periodo
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE ON ica_acumulado_periodo TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 3. compra_retencion por municipio
-- -----------------------------------------------------------------------------
ALTER TABLE compra_retencion
  ADD COLUMN municipio_codigo char(5) REFERENCES municipio (codigo),
  DROP CONSTRAINT uq_compra_retencion_concepto;
CREATE UNIQUE INDEX ux_compra_retencion_concepto_municipio
  ON compra_retencion (compra_documento_id, concepto, COALESCE(municipio_codigo, ''));

-- -----------------------------------------------------------------------------
-- 4. La bitácora admite las cargas de ICA
-- -----------------------------------------------------------------------------
ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
  CHECK (accion IN (
    'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
    'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
    'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
    'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
    'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
    'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT', 'CARGAR_PARAMETRO_ICA'));
