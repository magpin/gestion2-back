-- =============================================================================
-- 0104 — Recibo de caja: un cobro que salda una o varias facturas
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 3.
--
-- El cliente paga tres facturas con una sola transferencia. Hasta acá eso eran
-- tres cobros sueltos, cada uno desde su factura. El recibo es el documento
-- que los agrupa: un número (RC-000128), un cliente, una fecha, un medio y lo
-- que se abonó a cada factura.
--
-- No es un camino paralelo. Cada abono se registra por el cobro de siempre
-- —movimiento de caja o banco, asiento CI, `monto_pagado` de la factura—, así
-- que el libro de caja, la conciliación y el saldo de la factura siguen
-- teniendo una sola verdad. El recibo solo dice qué cobros fueron un mismo
-- acto. Anularlo devuelve cada cobro por la devolución de siempre.

CREATE TABLE recibo_caja (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  numero             int           NOT NULL CHECK (numero > 0),
  fecha              date          NOT NULL,
  tercero_id         uuid          NOT NULL,
  medio              text          NOT NULL CHECK (medio IN ('CAJA', 'BANCO')),
  caja_id            uuid,
  cuenta_bancaria_id uuid,
  total              numeric(18,2) NOT NULL CHECK (total > 0),
  estado             text          NOT NULL DEFAULT 'VIGENTE'
                       CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion   text,
  anulado_en         timestamptz,
  anulado_por        uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_por         uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_recibo_caja_numero UNIQUE (empresa_id, numero),
  CONSTRAINT uq_recibo_caja_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_recibo_caja_tercero FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_recibo_caja_caja FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_recibo_caja_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_recibo_caja_medio CHECK (
       (medio = 'CAJA'  AND caja_id IS NOT NULL AND cuenta_bancaria_id IS NULL)
    OR (medio = 'BANCO' AND cuenta_bancaria_id IS NOT NULL AND caja_id IS NULL)
  ),
  CONSTRAINT ck_recibo_caja_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL AND anulado_por IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_recibo_caja_fecha ON recibo_caja (empresa_id, fecha DESC);
CREATE INDEX ix_recibo_caja_tercero ON recibo_caja (empresa_id, tercero_id);

-- Lo que el recibo abonó a cada factura. Una factura aparece una sola vez por
-- recibo: dos renglones de la misma factura serían un solo abono partido.
CREATE TABLE recibo_caja_aplicacion (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  recibo_id          uuid          NOT NULL,
  venta_documento_id uuid          NOT NULL,
  valor              numeric(18,2) NOT NULL CHECK (valor > 0),
  CONSTRAINT uq_recibo_aplicacion UNIQUE (recibo_id, venta_documento_id),
  CONSTRAINT fk_recibo_aplicacion_recibo FOREIGN KEY (recibo_id, empresa_id)
    REFERENCES recibo_caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_recibo_aplicacion_venta FOREIGN KEY (venta_documento_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_recibo_aplicacion_venta ON recibo_caja_aplicacion (venta_documento_id);

-- El consecutivo de los recibos, uno por empresa. No es un documento fiscal:
-- no usa resoluciones DIAN, como las cotizaciones.
CREATE TABLE recibo_caja_consecutivo (
  empresa_id         uuid PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  consecutivo_actual int  NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recibo_caja', 'recibo_caja_aplicacion', 'recibo_caja_consecutivo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END $$;

-- El recibo no se edita ni se borra: solo se anula, y eso toca estas columnas.
GRANT SELECT, INSERT ON recibo_caja TO gestion_app, gestion_provision;
GRANT UPDATE (estado, motivo_anulacion, anulado_en, anulado_por)
  ON recibo_caja TO gestion_app, gestion_provision;
GRANT SELECT, INSERT ON recibo_caja_aplicacion TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON recibo_caja_consecutivo TO gestion_app, gestion_provision;
