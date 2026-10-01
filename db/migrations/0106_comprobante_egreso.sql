-- =============================================================================
-- 0106 — Pagos: comprobante de egreso, cruce de anticipos y pagos programados
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 4. Espejo de 0104 y
-- 0105 del lado de los proveedores.
--
-- A. `comprobante_egreso`: un pago que salda una o varias compras del mismo
--    proveedor, con su descuento por pronto pago obtenido, el 4×1000 si sale
--    de un banco que no es exento, y el anticipo que se le entrega. Cada pago
--    pasa por el de siempre (movimiento, asiento CE, `monto_pagado`).
--
-- B. `cruce_pago`: aplicar un anticipo a una compra. La retención que se le
--    practicó al anticipo se reversa en la proporción cruzada (D11b): la
--    compra ya retuvo lo correcto, con su concepto y su base.
--
-- C. `pago_programado`: lo que hay que pagar y cuándo —una compra que vence,
--    el arriendo de cada mes—. No mueve plata: es lo que alimenta «esta
--    semana sale» y los recurrentes.

-- ── A. Comprobante de egreso ────────────────────────────────────────────────
CREATE TABLE comprobante_egreso (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  numero                 int           NOT NULL CHECK (numero > 0),
  fecha                  date          NOT NULL,
  tercero_id             uuid          NOT NULL,
  medio                  text          NOT NULL CHECK (medio IN ('CAJA', 'BANCO')),
  caja_id                uuid,
  cuenta_bancaria_id     uuid,
  -- Lo que se le pagó en plata al proveedor: abonos más el neto del anticipo.
  total                  numeric(18,2) NOT NULL CHECK (total > 0),
  -- El anticipo bruto que se le entrega (antes de la retención).
  anticipo               numeric(18,2) NOT NULL DEFAULT 0 CHECK (anticipo >= 0),
  anticipo_movimiento_id uuid,
  -- El 4×1000 que cobró el banco por esta salida; cero en caja o cuenta exenta.
  gmf                    numeric(18,2) NOT NULL DEFAULT 0 CHECK (gmf >= 0),
  gmf_movimiento_id      uuid,
  estado                 text          NOT NULL DEFAULT 'VIGENTE'
                           CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion       text,
  anulado_en             timestamptz,
  anulado_por            uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_por             uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_comprobante_egreso_numero UNIQUE (empresa_id, numero),
  CONSTRAINT uq_comprobante_egreso_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_comprobante_egreso_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_comprobante_egreso_caja FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_comprobante_egreso_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_comprobante_egreso_medio CHECK (
       (medio = 'CAJA'  AND caja_id IS NOT NULL AND cuenta_bancaria_id IS NULL AND gmf = 0)
    OR (medio = 'BANCO' AND cuenta_bancaria_id IS NOT NULL AND caja_id IS NULL)
  ),
  CONSTRAINT ck_comprobante_egreso_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_comprobante_egreso_fecha ON comprobante_egreso (empresa_id, fecha DESC);
CREATE INDEX ix_comprobante_egreso_tercero ON comprobante_egreso (empresa_id, tercero_id);

CREATE TABLE comprobante_egreso_aplicacion (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  comprobante_id         uuid          NOT NULL,
  compra_documento_id    uuid          NOT NULL,
  valor                  numeric(18,2) NOT NULL CHECK (valor >= 0),
  -- El descuento por pronto pago que el proveedor concede: salda la compra
  -- sin que salga plata, contra el ingreso 421040.
  descuento              numeric(18,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
  asiento_descuento_id   uuid,
  CONSTRAINT uq_comprobante_aplicacion UNIQUE (comprobante_id, compra_documento_id),
  CONSTRAINT ck_comprobante_aplicacion_algo CHECK (valor + descuento > 0),
  CONSTRAINT fk_comprobante_aplicacion_comprobante FOREIGN KEY (comprobante_id, empresa_id)
    REFERENCES comprobante_egreso (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_comprobante_aplicacion_compra FOREIGN KEY (compra_documento_id, empresa_id)
    REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_comprobante_aplicacion_compra ON comprobante_egreso_aplicacion (compra_documento_id);

CREATE TABLE comprobante_egreso_consecutivo (
  empresa_id         uuid PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  consecutivo_actual int  NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0)
);

-- ── B. Cruce de anticipos a proveedores ─────────────────────────────────────
CREATE TABLE cruce_pago (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  tercero_id             uuid          NOT NULL,
  origen_movimiento_id   uuid          NOT NULL,
  destino_compra_id      uuid          NOT NULL,
  -- Lo que se cruza del anticipo, en bruto (lo que baja 133005).
  valor                  numeric(18,2) NOT NULL CHECK (valor > 0),
  -- La retención del anticipo que se reversa en esta proporción: lo que el
  -- proveedor recibe de más en la compra porque la compra ya retuvo.
  retencion_reversada    numeric(18,2) NOT NULL DEFAULT 0 CHECK (retencion_reversada >= 0),
  fecha                  date          NOT NULL,
  asiento_id             uuid,
  estado                 text          NOT NULL DEFAULT 'VIGENTE'
                           CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion       text,
  anulado_en             timestamptz,
  anulado_por            uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_por             uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT fk_cruce_pago_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cruce_pago_origen FOREIGN KEY (origen_movimiento_id, empresa_id)
    REFERENCES movimiento_concepto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cruce_pago_destino FOREIGN KEY (destino_compra_id, empresa_id)
    REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cruce_pago_retencion CHECK (retencion_reversada < valor),
  CONSTRAINT ck_cruce_pago_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_cruce_pago_tercero ON cruce_pago (empresa_id, tercero_id);
CREATE INDEX ix_cruce_pago_destino ON cruce_pago (destino_compra_id);

-- ── C. Pagos programados ────────────────────────────────────────────────────
CREATE TABLE pago_programado (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  descripcion      text          NOT NULL CHECK (length(btrim(descripcion)) > 0),
  tercero_id       uuid,
  -- Lo que se paga: una compra ya registrada, o un concepto (el arriendo).
  compra_id        uuid,
  concepto_id      uuid,
  valor            numeric(18,2) NOT NULL CHECK (valor > 0),
  fecha            date          NOT NULL,
  recurrencia      text          NOT NULL DEFAULT 'UNA_VEZ'
                     CHECK (recurrencia IN ('UNA_VEZ', 'MENSUAL')),
  estado           text          NOT NULL DEFAULT 'PENDIENTE'
                     CHECK (estado IN ('PENDIENTE', 'PAGADO', 'CANCELADO')),
  -- Con qué se pagó, si se pagó.
  comprobante_id   uuid,
  movimiento_id    uuid,
  resuelto_en      timestamptz,
  resuelto_por     uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_por       uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT fk_programado_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_programado_compra FOREIGN KEY (compra_id, empresa_id)
    REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_programado_concepto FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_programado_resuelto CHECK (
    (estado = 'PENDIENTE') = (resuelto_en IS NULL)
  )
);

CREATE INDEX ix_pago_programado_fecha ON pago_programado (empresa_id, fecha)
  WHERE estado = 'PENDIENTE';

-- ── RLS y permisos ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comprobante_egreso', 'comprobante_egreso_aplicacion',
                           'comprobante_egreso_consecutivo', 'cruce_pago', 'pago_programado'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END $$;
GRANT UPDATE (estado, motivo_anulacion, anulado_en, anulado_por, anticipo_movimiento_id,
              gmf_movimiento_id, gmf)
  ON comprobante_egreso TO gestion_app, gestion_provision;
GRANT UPDATE (asiento_descuento_id) ON comprobante_egreso_aplicacion
  TO gestion_app, gestion_provision;
GRANT UPDATE ON comprobante_egreso_consecutivo TO gestion_app, gestion_provision;
GRANT UPDATE (estado, motivo_anulacion, anulado_en, anulado_por) ON cruce_pago
  TO gestion_app, gestion_provision;
GRANT UPDATE (estado, comprobante_id, movimiento_id, resuelto_en, resuelto_por)
  ON pago_programado TO gestion_app, gestion_provision;
