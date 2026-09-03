-- =============================================================================
-- 0006_empresa_dian — resoluciones de numeración y credenciales de facturación
-- =============================================================================
-- Acá vive la AUTORIZACIÓN para emitir, no la transmisión. El envío del XML a la
-- DIAN, el CUFE/CUDE y el manejo de acuses son del módulo `dian`, más adelante.
--
-- Decisión: el consecutivo vive en la resolución, no en una tabla de configuración
-- aparte. El rango autorizado y el número que avanza dentro de ese rango son el
-- mismo hecho; separarlos permite que el consecutivo se salga del rango sin que
-- nadie lo note.

CREATE TABLE empresa_resolucion_dian (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid        NOT NULL REFERENCES empresa (id),
  tipo_documento        text        NOT NULL CHECK (tipo_documento IN (
                          'FACTURA_VENTA',
                          'FACTURA_CONTINGENCIA',
                          'NOTA_CREDITO',
                          'NOTA_DEBITO',
                          'DOCUMENTO_SOPORTE',
                          'NOTA_AJUSTE_DOC_SOPORTE',
                          'NOMINA_ELECTRONICA',
                          'POS')),
  numero_resolucion     varchar(30) NOT NULL,
  prefijo               varchar(6),
  rango_desde           bigint      NOT NULL CHECK (rango_desde >= 0),
  rango_hasta           bigint      NOT NULL,
  -- Último número emitido. Arranca en rango_desde - 1: aún no se ha emitido ninguno.
  consecutivo_actual    bigint      NOT NULL,
  fecha_resolucion      date        NOT NULL,
  fecha_vigencia_desde  date        NOT NULL,
  fecha_vigencia_hasta  date        NOT NULL,
  ambiente              text        NOT NULL DEFAULT 'HABILITACION'
                                    CHECK (ambiente IN ('HABILITACION', 'PRODUCCION')),
  -- La DIAN entrega una clave técnica por resolución; entra en el cálculo del CUFE.
  clave_tecnica_enc     text,
  activa                boolean     NOT NULL DEFAULT true,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  actualizado_en        timestamptz,

  CONSTRAINT ck_resolucion_rango      CHECK (rango_hasta >= rango_desde),
  CONSTRAINT ck_resolucion_vigencia   CHECK (fecha_vigencia_hasta >= fecha_vigencia_desde),
  -- El consecutivo nunca puede salirse del rango autorizado. Cuando llega a
  -- rango_hasta, la resolución se agotó y hay que pedir otra a la DIAN.
  CONSTRAINT ck_resolucion_consecutivo CHECK (consecutivo_actual BETWEEN rango_desde - 1 AND rango_hasta),
  CONSTRAINT uq_resolucion_numero      UNIQUE (empresa_id, numero_resolucion, tipo_documento)
);

-- Una sola resolución activa por empresa, tipo de documento y ambiente.
-- Sin esto, `tomarConsecutivo` no sabría de cuál de dos tomar.
CREATE UNIQUE INDEX ux_resolucion_activa
  ON empresa_resolucion_dian (empresa_id, tipo_documento, ambiente)
  WHERE activa;

CREATE INDEX ix_resolucion_empresa ON empresa_resolucion_dian (empresa_id);

COMMENT ON COLUMN empresa_resolucion_dian.consecutivo_actual IS
  'Se avanza con UPDATE ... RETURNING dentro de la transaccion del documento. El bloqueo de fila es lo que garantiza numeracion sin huecos ni repetidos.';

CREATE TRIGGER tg_resolucion_actualizado
  BEFORE UPDATE ON empresa_resolucion_dian
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Credenciales de facturación electrónica — 1:1 con la empresa
-- -----------------------------------------------------------------------------
-- Todo lo sensible va cifrado a nivel de aplicación, en columnas con sufijo _enc.
-- Jamás texto plano, jamás en logs, jamás en una respuesta de la API.
CREATE TABLE empresa_credencial_dian (
  empresa_id              uuid        PRIMARY KEY REFERENCES empresa (id),
  software_id_enc         text,
  software_pin_enc        text,
  certificado_p12_enc     bytea,
  certificado_clave_enc   text,
  certificado_vence_en    date,
  proveedor_tecnologico   text,
  test_set_id             text,
  habilitado_en           timestamptz,
  creado_en               timestamptz NOT NULL DEFAULT now(),
  actualizado_en          timestamptz
);

COMMENT ON TABLE empresa_credencial_dian IS
  'Secretos DIAN. Cifrado a nivel de aplicacion; la base solo almacena el texto cifrado.';
COMMENT ON COLUMN empresa_credencial_dian.certificado_vence_en IS
  'Sin cifrar a proposito: permite avisar del vencimiento sin descifrar el certificado.';

CREATE TRIGGER tg_credencial_dian_actualizado
  BEFORE UPDATE ON empresa_credencial_dian
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
ALTER TABLE empresa_resolucion_dian ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_resolucion_dian FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_resolucion_aislada ON empresa_resolucion_dian
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

ALTER TABLE empresa_credencial_dian ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_credencial_dian FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_credencial_dian_aislada ON empresa_credencial_dian
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON empresa_resolucion_dian TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON empresa_credencial_dian  TO gestion_app, gestion_provision;

