-- Renta (110): lo que el estimado y el pago por cuotas necesitan
-- (Fase 4 de docs/planes/plan-pantallas-complementarias.md).
--
-- 1. `empresa_impuesto_config.zomac_tamano`: una sociedad ZOMAC paga una parte
--    de la tarifa general (Ley 1819 de 2016, art. 237). El factor por año ya es
--    ley cargada (`retencion_zomac_factor`); falta saber si la empresa lo es.
--
-- 2. `declaracion`: de la renta se guardan dos renglones más del 110, que usa
--    el año siguiente: el impuesto neto (para el anticipo por promedio) y el
--    anticipo que se liquidó para el año siguiente (se resta en ese año).
--    `cuotas`: en cuántas se paga (2; 3 el gran contribuyente).
--
-- 3. `declaracion_pago`: la renta se paga por cuotas, cada una con su recibo
--    490 y su asiento. La declaración pasa a PAGADA con la última.

ALTER TABLE empresa_impuesto_config
  ADD COLUMN zomac_tamano text
    CHECK (zomac_tamano IS NULL OR zomac_tamano IN ('MICRO', 'PEQUENA', 'MEDIANA', 'GRANDE'));
GRANT UPDATE (zomac_tamano) ON empresa_impuesto_config TO gestion_app, gestion_provision;

ALTER TABLE declaracion
  ADD COLUMN impuesto_neto      numeric(18,2) CHECK (impuesto_neto IS NULL OR impuesto_neto >= 0),
  ADD COLUMN anticipo_siguiente numeric(18,2) CHECK (anticipo_siguiente IS NULL OR anticipo_siguiente >= 0),
  ADD COLUMN cuotas             smallint      NOT NULL DEFAULT 1 CHECK (cuotas BETWEEN 1 AND 3),
  ADD CONSTRAINT ck_declaracion_renta CHECK (
    obligacion = 'RENTA' OR (impuesto_neto IS NULL AND anticipo_siguiente IS NULL AND cuotas = 1));
GRANT UPDATE (impuesto_neto, anticipo_siguiente) ON declaracion TO gestion_app, gestion_provision;

CREATE TABLE declaracion_pago (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  declaracion_id      uuid          NOT NULL,
  cuota               smallint      NOT NULL CHECK (cuota BETWEEN 1 AND 3),
  valor               numeric(18,2) NOT NULL CHECK (valor > 0),
  intereses           numeric(18,2) NOT NULL DEFAULT 0 CHECK (intereses >= 0),
  recibo_490          text          NOT NULL CHECK (length(trim(recibo_490)) > 0),
  pagada_el           date          NOT NULL,
  medio               text          NOT NULL CHECK (medio IN ('CAJA', 'BANCO')),
  caja_id             uuid,
  cuenta_bancaria_id  uuid,
  asiento_id          uuid          NOT NULL,
  movimiento_id       uuid,
  gmf_movimiento_id   uuid,
  gmf                 numeric(18,2) NOT NULL DEFAULT 0 CHECK (gmf >= 0),
  creado_por          uuid          NOT NULL,
  creado_en           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_declaracion_pago_cuota UNIQUE (declaracion_id, cuota),
  CONSTRAINT fk_declaracion_pago_declaracion FOREIGN KEY (declaracion_id, empresa_id)
    REFERENCES declaracion (id, empresa_id),
  CONSTRAINT fk_declaracion_pago_asiento FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id),
  CONSTRAINT fk_declaracion_pago_caja FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id),
  CONSTRAINT fk_declaracion_pago_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id),
  CONSTRAINT ck_declaracion_pago_medio CHECK (
    (medio = 'CAJA' AND caja_id IS NOT NULL AND cuenta_bancaria_id IS NULL)
    OR (medio = 'BANCO' AND cuenta_bancaria_id IS NOT NULL AND caja_id IS NULL))
);

CREATE INDEX ix_declaracion_pago_declaracion ON declaracion_pago (declaracion_id);

ALTER TABLE declaracion_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE declaracion_pago FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_declaracion_pago_aislado ON declaracion_pago
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- Un pago no se edita: se registra una vez.
GRANT SELECT, INSERT ON declaracion_pago TO gestion_app, gestion_provision;
