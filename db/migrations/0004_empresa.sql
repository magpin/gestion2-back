-- =============================================================================
-- 0004_empresa — la unidad contable y sus sedes
-- =============================================================================
-- Una empresa = un NIT = una contabilidad independiente. Todo dato contable del
-- sistema cuelga de acá.

CREATE TABLE empresa (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenant (id),
  tipo_persona    text        NOT NULL CHECK (tipo_persona IN ('JURIDICA','NATURAL')),
  razon_social    text        NOT NULL CHECK (length(btrim(razon_social)) > 0),
  nombre_comercial text,
  nit             varchar(15) NOT NULL CHECK (nit ~ '^[0-9]{5,15}$'),
  dv              char(1)     NOT NULL CHECK (dv ~ '^[0-9]$'),
  sector_economico text       NOT NULL
                              CHECK (sector_economico IN ('COMERCIO','SERVICIOS','MANUFACTURA','MIXTO')),
  activo          boolean     NOT NULL DEFAULT true,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz,

  -- El DV no se captura: se verifica. Un NIT con DV errado no entra.
  CONSTRAINT ck_empresa_dv        CHECK (dv = fn_dv_nit(nit)),
  -- El NIT es único dentro del tenant, no global: dos clientes distintos del
  -- software pueden llevar la contabilidad de empresas distintas sin chocar.
  CONSTRAINT uq_empresa_tenant_nit UNIQUE (tenant_id, nit),
  -- Necesaria para las FK compuestas que impiden mezclar tenants (ver 0006).
  CONSTRAINT uq_empresa_id_tenant  UNIQUE (id, tenant_id)
);

CREATE INDEX ix_empresa_tenant ON empresa (tenant_id) WHERE activo;

CREATE TRIGGER tg_empresa_actualizado
  BEFORE UPDATE ON empresa
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

ALTER TABLE empresa ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_empresa_aislada ON empresa
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON empresa TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON empresa TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Sedes / establecimientos de comercio
-- -----------------------------------------------------------------------------
-- La sede define el municipio, y el municipio define la tarifa de ICA y el código
-- que va en la factura electrónica.

CREATE TABLE empresa_sede (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid        NOT NULL REFERENCES empresa (id),
  codigo             text        NOT NULL CHECK (length(btrim(codigo)) > 0),
  nombre             text        NOT NULL,
  direccion          text        NOT NULL,
  municipio_codigo   char(5)     NOT NULL REFERENCES municipio (codigo),
  telefono           text,
  email              citext,
  es_principal       boolean     NOT NULL DEFAULT false,
  activo             boolean     NOT NULL DEFAULT true,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz,

  CONSTRAINT uq_sede_empresa_codigo UNIQUE (empresa_id, codigo)
);

-- Una sola sede principal activa por empresa. Lo sostiene Postgres, no el código.
CREATE UNIQUE INDEX ux_sede_principal
  ON empresa_sede (empresa_id) WHERE es_principal AND activo;

CREATE INDEX ix_sede_empresa ON empresa_sede (empresa_id);

CREATE TRIGGER tg_sede_actualizado
  BEFORE UPDATE ON empresa_sede
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

ALTER TABLE empresa_sede ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_sede FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_sede_aislada ON empresa_sede
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON empresa_sede TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON empresa_sede TO gestion_provision;

