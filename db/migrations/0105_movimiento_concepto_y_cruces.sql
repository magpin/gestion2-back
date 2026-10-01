-- =============================================================================
-- 0105 — Plata que entra o sale por un concepto, y los cruces de cartera
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fases 3 y 4.
--
-- A. `movimiento_concepto` (Tesorería): un ingreso o un egreso sin factura,
--    elegido por concepto y no por cuenta —un rendimiento, el abono a capital
--    de un crédito, el 4×1000, la comisión del datáfono, un anticipo—. Por
--    dentro es el movimiento de caja o banco de siempre, con su asiento; esto
--    guarda qué concepto fue, a quién y cuánto fue al concepto (que en un
--    anticipo con retención no es lo que salió de la caja).
--
-- B. El recibo de caja gana la comisión del datáfono, el anticipo que deja el
--    cliente y el descuento por pronto pago que se le concede en cada factura.
--
-- C. `cruce_cartera` (Ventas): aplicar a una factura un anticipo del cliente o
--    el saldo a favor que le dejó una nota crédito en otra factura.
--
-- D. El motor de retenciones puede registrar la retención de un anticipo a
--    proveedor (D11b): entra a la 350 como cualquier otra.

-- ── A. Movimiento por concepto ──────────────────────────────────────────────
CREATE TABLE movimiento_concepto (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  direccion             text          NOT NULL CHECK (direccion IN ('ENTRADA', 'SALIDA')),
  medio                 text          NOT NULL CHECK (medio IN ('CAJA', 'BANCO')),
  caja_id               uuid,
  cuenta_bancaria_id    uuid,
  -- El movimiento del libro de caja o de banco que lo registró.
  caja_movimiento_id    uuid,
  banco_movimiento_id   uuid,
  asiento_id            uuid,
  concepto_id           uuid          NOT NULL,
  tercero_id            uuid,
  fecha                 date          NOT NULL,
  -- Lo que va al concepto. En un anticipo a proveedor con retención es el
  -- bruto: el anticipo es por eso, aunque de la caja salga el neto.
  valor_concepto        numeric(18,2) NOT NULL CHECK (valor_concepto > 0),
  -- Lo que entró o salió de la caja o del banco.
  valor_movido          numeric(18,2) NOT NULL CHECK (valor_movido > 0),
  detalle               text          NOT NULL CHECK (length(btrim(detalle)) > 0),
  -- Quién lo originó: una persona a mano, o un documento que lo necesitó.
  origen                text          NOT NULL DEFAULT 'MANUAL' CHECK (origen IN
                          ('MANUAL', 'RECIBO_CAJA', 'COMPROBANTE_EGRESO', 'GMF')),
  origen_id             uuid,
  estado                text          NOT NULL DEFAULT 'VIGENTE'
                          CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion      text,
  anulado_en            timestamptz,
  anulado_por           uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  -- El movimiento contrario que lo anuló en el libro.
  anulacion_movimiento_id uuid,
  creado_por            uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_movimiento_concepto_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_movimiento_concepto_concepto FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_movimiento_concepto_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_movimiento_concepto_caja FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_movimiento_concepto_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_movimiento_concepto_medio CHECK (
       (medio = 'CAJA'  AND caja_id IS NOT NULL AND cuenta_bancaria_id IS NULL)
    OR (medio = 'BANCO' AND cuenta_bancaria_id IS NOT NULL AND caja_id IS NULL)
  ),
  CONSTRAINT ck_movimiento_concepto_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_movimiento_concepto_fecha ON movimiento_concepto (empresa_id, fecha DESC);
CREATE INDEX ix_movimiento_concepto_tercero ON movimiento_concepto (empresa_id, tercero_id)
  WHERE tercero_id IS NOT NULL;
CREATE INDEX ix_movimiento_concepto_origen ON movimiento_concepto (origen, origen_id)
  WHERE origen_id IS NOT NULL;

-- ── B. El recibo de caja: comisión, anticipo y descuento ────────────────────
ALTER TABLE recibo_caja
  -- Lo que se quedó el datáfono o la pasarela: sale del mismo medio.
  ADD COLUMN comision               numeric(18,2) NOT NULL DEFAULT 0 CHECK (comision >= 0),
  ADD COLUMN comision_movimiento_id uuid,
  -- Lo que el cliente pagó de más o por adelantado: queda como anticipo suyo.
  ADD COLUMN anticipo               numeric(18,2) NOT NULL DEFAULT 0 CHECK (anticipo >= 0),
  ADD COLUMN anticipo_movimiento_id uuid,
  ADD CONSTRAINT ck_recibo_comision CHECK (comision < total);

ALTER TABLE recibo_caja_aplicacion
  -- El descuento por pronto pago que se le concede en esta factura: la salda
  -- sin que entre plata, contra el gasto 530535.
  ADD COLUMN descuento           numeric(18,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
  ADD COLUMN asiento_descuento_id uuid,
  -- Un renglón puede ser solo descuento (la plata ya había entrado): el
  -- abono en efectivo puede ser cero si el descuento no lo es.
  DROP CONSTRAINT recibo_caja_aplicacion_valor_check,
  ADD CONSTRAINT ck_recibo_aplicacion_valor CHECK (valor >= 0 AND valor + descuento > 0);

-- ── C. Cruces de cartera ────────────────────────────────────────────────────
CREATE TABLE cruce_cartera (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  tipo                   text          NOT NULL CHECK (tipo IN ('ANTICIPO', 'SALDO_A_FAVOR')),
  tercero_id             uuid          NOT NULL,
  -- De dónde sale: el anticipo (un movimiento por concepto) o la factura
  -- que quedó con saldo a favor del cliente.
  origen_movimiento_id   uuid,
  origen_venta_id        uuid,
  destino_venta_id       uuid          NOT NULL,
  valor                  numeric(18,2) NOT NULL CHECK (valor > 0),
  fecha                  date          NOT NULL,
  -- El anticipo pasa de 280505 a 130505; el saldo a favor se queda en 130505
  -- (mismo cliente) y no lleva asiento.
  asiento_id             uuid,
  estado                 text          NOT NULL DEFAULT 'VIGENTE'
                           CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion       text,
  anulado_en             timestamptz,
  anulado_por            uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_por             uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT fk_cruce_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cruce_origen_mov FOREIGN KEY (origen_movimiento_id, empresa_id)
    REFERENCES movimiento_concepto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cruce_origen_venta FOREIGN KEY (origen_venta_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_cruce_destino_venta FOREIGN KEY (destino_venta_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_cruce_origen CHECK (
       (tipo = 'ANTICIPO'      AND origen_movimiento_id IS NOT NULL AND origen_venta_id IS NULL)
    OR (tipo = 'SALDO_A_FAVOR' AND origen_venta_id IS NOT NULL AND origen_movimiento_id IS NULL
                               AND origen_venta_id <> destino_venta_id)
  ),
  CONSTRAINT ck_cruce_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_cruce_cartera_tercero ON cruce_cartera (empresa_id, tercero_id);
CREATE INDEX ix_cruce_cartera_destino ON cruce_cartera (destino_venta_id);

-- ── RLS y permisos ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['movimiento_concepto', 'cruce_cartera'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    -- No se borran ni se editan: solo se anulan.
    EXECUTE format('GRANT SELECT, INSERT ON %I TO gestion_app, gestion_provision', t);
    EXECUTE format(
      'GRANT UPDATE (estado, motivo_anulacion, anulado_en, anulado_por) ON %I TO gestion_app, gestion_provision',
      t);
  END LOOP;
END $$;
GRANT UPDATE (anulacion_movimiento_id) ON movimiento_concepto TO gestion_app, gestion_provision;
GRANT UPDATE (comision_movimiento_id, anticipo_movimiento_id) ON recibo_caja
  TO gestion_app, gestion_provision;
GRANT UPDATE (asiento_descuento_id) ON recibo_caja_aplicacion TO gestion_app, gestion_provision;

-- ── D. Retención de un anticipo a proveedor (D11b) ──────────────────────────
ALTER TABLE retencion_calculada
  DROP CONSTRAINT retencion_calculada_documento_tipo_check,
  ADD CONSTRAINT retencion_calculada_documento_tipo_check CHECK (documento_tipo IN
    ('COMPRA', 'NOTA_CREDITO_COMPRA', 'NOTA_DEBITO_COMPRA', 'VENTA', 'NOTA_CREDITO_VENTA',
     'ANTICIPO_PROVEEDOR'));
