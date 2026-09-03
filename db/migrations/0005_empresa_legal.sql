-- =============================================================================
-- 0005_empresa_legal — condiciones legales con vigencia + configuración contable
-- =============================================================================
-- Las cuatro tablas históricas NO se editan: la fila vigente se cierra con
-- fecha_fin y se abre otra. Por eso no llevan actualizado_en ni trigger — no hay
-- nada que marcar como actualizado.
--
-- "Un solo vigente" lo garantiza un índice único parcial sobre WHERE fecha_fin IS NULL.
-- La regla la sostiene el motor; el código no tiene forma de saltársela.

-- -----------------------------------------------------------------------------
-- Actividad económica (CIIU) + tarifa de ICA
-- -----------------------------------------------------------------------------
CREATE TABLE empresa_actividad_economica (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid         NOT NULL REFERENCES empresa (id),
  codigo_ciiu        varchar(6)   NOT NULL CHECK (codigo_ciiu ~ '^[0-9]{4}$'),
  descripcion        text         NOT NULL,
  es_principal       boolean      NOT NULL DEFAULT false,
  -- ICA es municipal y se cotiza por mil (ej. 4.140 = 4,14 por mil).
  tarifa_ica_por_mil numeric(7,3) CHECK (tarifa_ica_por_mil >= 0),
  municipio_codigo   char(5)      REFERENCES municipio (codigo),
  fecha_inicio       date         NOT NULL,
  fecha_fin          date,
  creado_en          timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ck_actividad_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE UNIQUE INDEX ux_actividad_principal_vigente
  ON empresa_actividad_economica (empresa_id)
  WHERE es_principal AND fecha_fin IS NULL;

CREATE UNIQUE INDEX ux_actividad_ciiu_vigente
  ON empresa_actividad_economica (empresa_id, codigo_ciiu)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_actividad_empresa ON empresa_actividad_economica (empresa_id);

-- -----------------------------------------------------------------------------
-- Régimen tributario — una fila por condición, cada una con su vigencia
-- -----------------------------------------------------------------------------
-- Una empresa cursa varias a la vez: puede ser RESPONSABLE_IVA y
-- AGENTE_RETENEDOR_RENTA al mismo tiempo. Nunca un booleano plano: la DIAN puede
-- exigir demostrar cuál era la condición vigente en una fecha pasada.
CREATE TABLE empresa_regimen_tributario (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                  uuid        NOT NULL REFERENCES empresa (id),
  tipo_regimen                text        NOT NULL CHECK (tipo_regimen IN (
                                'RESPONSABLE_IVA',
                                'NO_RESPONSABLE_IVA',
                                'RESPONSABLE_INC',
                                'AGENTE_RETENEDOR_RENTA',
                                'AGENTE_RETENEDOR_IVA',
                                'AGENTE_RETENEDOR_ICA',
                                'AUTORRETENEDOR_RENTA',
                                'GRAN_CONTRIBUYENTE',
                                'REGIMEN_SIMPLE',
                                'REGIMEN_ORDINARIO',
                                'ENTIDAD_SIN_ANIMO_DE_LUCRO',
                                'EXENTO_RENTA')),
  -- Código de responsabilidad fiscal del anexo técnico DIAN (O-13, O-15, O-23, O-47, R-99-PN...).
  codigo_responsabilidad_dian text,
  acto_administrativo         text,
  fecha_inicio                date        NOT NULL,
  fecha_fin                   date,
  creado_en                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_regimen_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE UNIQUE INDEX ux_regimen_vigente
  ON empresa_regimen_tributario (empresa_id, tipo_regimen)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_regimen_empresa ON empresa_regimen_tributario (empresa_id);

-- -----------------------------------------------------------------------------
-- Representante legal
-- -----------------------------------------------------------------------------
CREATE TABLE empresa_representante (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid        NOT NULL REFERENCES empresa (id),
  tipo_representante text        NOT NULL DEFAULT 'PRINCIPAL'
                                 CHECK (tipo_representante IN ('PRINCIPAL', 'SUPLENTE')),
  nombre_completo    text        NOT NULL,
  tipo_documento     text        NOT NULL CHECK (tipo_documento IN ('CC', 'CE', 'PA', 'NIT', 'PEP')),
  numero_documento   varchar(20) NOT NULL,
  cargo              text,
  fecha_inicio       date        NOT NULL,
  fecha_fin          date,
  creado_en          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_representante_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE UNIQUE INDEX ux_representante_vigente
  ON empresa_representante (empresa_id, tipo_representante)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_representante_empresa ON empresa_representante (empresa_id);

-- -----------------------------------------------------------------------------
-- Matrícula mercantil
-- -----------------------------------------------------------------------------
CREATE TABLE empresa_matricula_mercantil (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id              uuid        NOT NULL REFERENCES empresa (id),
  numero_matricula        varchar(30) NOT NULL,
  camara_comercio         text        NOT NULL,
  fecha_matricula         date        NOT NULL,
  fecha_ultima_renovacion date,
  fecha_inicio            date        NOT NULL,
  fecha_fin               date,
  creado_en               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_matricula_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

CREATE UNIQUE INDEX ux_matricula_vigente
  ON empresa_matricula_mercantil (empresa_id)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_matricula_empresa ON empresa_matricula_mercantil (empresa_id);

-- -----------------------------------------------------------------------------
-- Configuración contable — 1:1, no histórica
-- -----------------------------------------------------------------------------
-- Es lo primero que consulta el módulo de contabilidad antes de permitir un asiento.
CREATE TABLE empresa_configuracion_contable (
  empresa_id                   uuid        PRIMARY KEY REFERENCES empresa (id),
  grupo_niif                   text        NOT NULL
                                           CHECK (grupo_niif IN ('GRUPO_1', 'GRUPO_2', 'GRUPO_3')),
  moneda_funcional             char(3)     NOT NULL DEFAULT 'COP',
  mes_cierre_fiscal            smallint    NOT NULL DEFAULT 12
                                           CHECK (mes_cierre_fiscal BETWEEN 1 AND 12),
  metodo_valoracion_inventario text        NOT NULL DEFAULT 'PROMEDIO_PONDERADO'
                                           CHECK (metodo_valoracion_inventario IN ('PROMEDIO_PONDERADO', 'PEPS')),
  decimales_valor              smallint    NOT NULL DEFAULT 2 CHECK (decimales_valor BETWEEN 0 AND 6),
  decimales_cantidad           smallint    NOT NULL DEFAULT 2 CHECK (decimales_cantidad BETWEEN 0 AND 6),
  maneja_centro_de_costo       boolean     NOT NULL DEFAULT false,
  fecha_inicio_operaciones     date        NOT NULL,
  creado_en                    timestamptz NOT NULL DEFAULT now(),
  actualizado_en               timestamptz
);

COMMENT ON COLUMN empresa_configuracion_contable.grupo_niif IS
  'GRUPO_2 (NIIF PYMES) es lo habitual. Cambiar de grupo es un evento auditable, no una edicion cualquiera.';

CREATE TRIGGER tg_config_contable_actualizado
  BEFORE UPDATE ON empresa_configuracion_contable
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios para las cinco tablas
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'empresa_actividad_economica',
    'empresa_regimen_tributario',
    'empresa_representante',
    'empresa_matricula_mercantil',
    'empresa_configuracion_contable'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislada ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;

