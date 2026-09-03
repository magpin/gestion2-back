-- =============================================================================
-- 0008_tercero — clientes y proveedores
-- =============================================================================
-- El tercero es de la empresa, no del tenant: cada contabilidad tiene su propio
-- maestro. Dos empresas del mismo tenant pueden compartir proveedor en la vida
-- real y aun así son dos filas — sus saldos, su cartera y su historia son distintos.

CREATE TABLE tercero (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid        NOT NULL REFERENCES empresa (id),
  tipo_persona       text        NOT NULL CHECK (tipo_persona IN ('NATURAL', 'JURIDICA')),
  tipo_documento     text        NOT NULL CHECK (tipo_documento IN (
                       'CC',   -- cédula de ciudadanía
                       'CE',   -- cédula de extranjería
                       'NIT',
                       'TI',   -- tarjeta de identidad
                       'RC',   -- registro civil
                       'PA',   -- pasaporte
                       'PEP',  -- permiso especial de permanencia
                       'PPT',  -- permiso por protección temporal
                       'NIT_EXTRANJERO',
                       'NUIP',
                       'DOC_EXTRANJERO')),
  numero_documento   varchar(20) NOT NULL CHECK (length(btrim(numero_documento)) > 0),
  dv                 char(1)     CHECK (dv IS NULL OR dv ~ '^[0-9]$'),

  -- Persona jurídica usa razon_social. Persona natural usa los cuatro campos de
  -- nombre por separado, que es como los pide el anexo técnico de la DIAN.
  razon_social       text,
  primer_nombre      text,
  segundo_nombre     text,
  primer_apellido    text,
  segundo_apellido   text,
  nombre_comercial   text,

  email              citext,
  telefono           text,
  direccion          text,
  municipio_codigo   char(5)     REFERENCES municipio (codigo),

  es_cliente         boolean     NOT NULL DEFAULT false,
  es_proveedor       boolean     NOT NULL DEFAULT false,

  -- Condición fiscal del tercero al día de hoy. Se copia congelada dentro de cada
  -- documento que se le emita: si mañana cambia, la factura de ayer no cambia.
  responsable_iva    boolean     NOT NULL DEFAULT false,
  es_agente_retenedor boolean    NOT NULL DEFAULT false,
  es_autorretenedor  boolean     NOT NULL DEFAULT false,
  es_gran_contribuyente boolean  NOT NULL DEFAULT false,
  regimen_simple     boolean     NOT NULL DEFAULT false,

  activo             boolean     NOT NULL DEFAULT true,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz,

  -- Un tercero es cliente, proveedor o ambos. Nunca ninguno: sin eso no hay
  -- razón para que exista la fila.
  CONSTRAINT ck_tercero_rol CHECK (es_cliente OR es_proveedor),

  -- Jurídica exige razón social; natural exige al menos primer nombre y apellido.
  CONSTRAINT ck_tercero_nombre CHECK (
    (tipo_persona = 'JURIDICA' AND razon_social IS NOT NULL AND length(btrim(razon_social)) > 0)
    OR
    (tipo_persona = 'NATURAL'
      AND primer_nombre   IS NOT NULL AND length(btrim(primer_nombre))   > 0
      AND primer_apellido IS NOT NULL AND length(btrim(primer_apellido)) > 0)
  ),

  -- Si es NIT, el DV es obligatorio y tiene que cuadrar.
  CONSTRAINT ck_tercero_dv CHECK (
    tipo_documento <> 'NIT' OR (dv IS NOT NULL AND dv = fn_dv_nit(numero_documento))
  ),

  CONSTRAINT uq_tercero_documento UNIQUE (empresa_id, tipo_documento, numero_documento)
);

CREATE INDEX ix_tercero_empresa    ON tercero (empresa_id) WHERE activo;
CREATE INDEX ix_tercero_cliente    ON tercero (empresa_id) WHERE es_cliente   AND activo;
CREATE INDEX ix_tercero_proveedor  ON tercero (empresa_id) WHERE es_proveedor AND activo;

-- Búsqueda por nombre sin tildes ni mayúsculas: es la consulta que más se usa
-- en el mostrador.
CREATE INDEX ix_tercero_busqueda ON tercero (
  empresa_id,
  fn_normalizar(coalesce(razon_social, '') || ' ' ||
                coalesce(primer_nombre, '') || ' ' ||
                coalesce(primer_apellido, ''))
);

CREATE TRIGGER tg_tercero_actualizado
  BEFORE UPDATE ON tercero
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Responsabilidades fiscales del tercero (códigos del anexo técnico DIAN)
-- -----------------------------------------------------------------------------
-- Van en el XML del receptor. Se guardan como lista porque un tercero puede
-- cargar varias a la vez.
CREATE TABLE tercero_responsabilidad_fiscal (
  tercero_id  uuid        NOT NULL REFERENCES tercero (id),
  codigo      text        NOT NULL CHECK (codigo ~ '^[A-Z]-[0-9]{2}(-[A-Z]{2})?$'),
  empresa_id  uuid        NOT NULL REFERENCES empresa (id),
  creado_en   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tercero_id, codigo)
);

COMMENT ON COLUMN tercero_responsabilidad_fiscal.codigo IS
  'Codigo del anexo tecnico DIAN: O-13 gran contribuyente, O-15 autorretenedor, O-23 agente de retencion IVA, O-47 regimen simple, R-99-PN no responsable.';
COMMENT ON COLUMN tercero_responsabilidad_fiscal.empresa_id IS
  'Redundante con tercero.empresa_id a proposito: permite aplicar RLS sin un JOIN en cada consulta.';

CREATE INDEX ix_responsabilidad_empresa ON tercero_responsabilidad_fiscal (empresa_id);

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
ALTER TABLE tercero ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_tercero_aislado ON tercero
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

ALTER TABLE tercero_responsabilidad_fiscal ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero_responsabilidad_fiscal FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_responsabilidad_aislada ON tercero_responsabilidad_fiscal
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON tercero                       TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON tercero_responsabilidad_fiscal TO gestion_app, gestion_provision;
-- Excepción al "nada se borra": una responsabilidad fiscal mal marcada no es un
-- hecho contable, es un atributo. Quitarla no deja huérfanos ni huecos.
GRANT DELETE ON tercero_responsabilidad_fiscal TO gestion_app;

