-- =============================================================================
-- 0107 — Traslados entre caja y bancos
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 5.
--
-- Una consignación del efectivo, un retiro para la caja, una transferencia
-- entre cuentas propias: la plata cambia de lugar y no es ingreso ni gasto.
-- Hasta hoy se registraba como dos movimientos sueltos, cada uno con su
-- asiento contra una cuenta elegida a mano, y era fácil asentarlo dos veces.
--
-- `traslado` los une: UN asiento (débito al destino, crédito al origen) y un
-- movimiento en cada libro que apunta a ese mismo asiento, con
-- `origen_tipo = 'TRASLADO'`. Si sale de un banco que no es exento, el 4×1000
-- va aparte como un movimiento por concepto (GTO-GMF). Anular deshace los dos
-- lados con un solo asiento invertido.

-- ── Los libros aceptan el origen nuevo ──────────────────────────────────────
ALTER TABLE caja_movimiento DROP CONSTRAINT caja_movimiento_origen_tipo_check;
ALTER TABLE caja_movimiento ADD CONSTRAINT ck_caja_mov_origen_tipo
  CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA', 'TRASLADO'));

ALTER TABLE banco_movimiento DROP CONSTRAINT banco_movimiento_origen_tipo_check;
ALTER TABLE banco_movimiento ADD CONSTRAINT ck_banco_mov_origen_tipo
  CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA', 'TRASLADO'));

-- ── El documento ────────────────────────────────────────────────────────────
CREATE TABLE traslado (
  id                         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                 uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  numero                     int           NOT NULL CHECK (numero > 0),
  fecha                      date          NOT NULL,
  origen_medio               text          NOT NULL CHECK (origen_medio IN ('CAJA', 'BANCO')),
  origen_caja_id             uuid,
  origen_cuenta_bancaria_id  uuid,
  destino_medio              text          NOT NULL CHECK (destino_medio IN ('CAJA', 'BANCO')),
  destino_caja_id            uuid,
  destino_cuenta_bancaria_id uuid,
  valor                      numeric(18,2) NOT NULL CHECK (valor > 0),
  detalle                    text          NOT NULL CHECK (length(btrim(detalle)) > 0),
  asiento_id                 uuid          NOT NULL,
  salida_movimiento_id       uuid          NOT NULL,
  entrada_movimiento_id      uuid          NOT NULL,
  -- El 4×1000 que cobró el banco de origen; cero si sale de caja, de una
  -- cuenta exenta o va a otra cuenta propia del mismo banco.
  gmf                        numeric(18,2) NOT NULL DEFAULT 0 CHECK (gmf >= 0),
  gmf_movimiento_id          uuid,
  estado                     text          NOT NULL DEFAULT 'VIGENTE'
                               CHECK (estado IN ('VIGENTE', 'ANULADO')),
  motivo_anulacion           text,
  anulado_en                 timestamptz,
  anulado_por                uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  asiento_anulacion_id       uuid,
  creado_por                 uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en                  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_traslado_numero UNIQUE (empresa_id, numero),
  CONSTRAINT uq_traslado_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_traslado_origen_caja FOREIGN KEY (origen_caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traslado_origen_cuenta FOREIGN KEY (origen_cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traslado_destino_caja FOREIGN KEY (destino_caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traslado_destino_cuenta FOREIGN KEY (destino_cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traslado_asiento FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traslado_asiento_anulacion FOREIGN KEY (asiento_anulacion_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_traslado_origen CHECK (
       (origen_medio = 'CAJA'  AND origen_caja_id IS NOT NULL AND origen_cuenta_bancaria_id IS NULL AND gmf = 0)
    OR (origen_medio = 'BANCO' AND origen_cuenta_bancaria_id IS NOT NULL AND origen_caja_id IS NULL)
  ),
  CONSTRAINT ck_traslado_destino CHECK (
       (destino_medio = 'CAJA'  AND destino_caja_id IS NOT NULL AND destino_cuenta_bancaria_id IS NULL)
    OR (destino_medio = 'BANCO' AND destino_cuenta_bancaria_id IS NOT NULL AND destino_caja_id IS NULL)
  ),
  -- A sí misma no: no movería nada.
  CONSTRAINT ck_traslado_distinto CHECK (
    origen_caja_id IS DISTINCT FROM destino_caja_id
    OR origen_cuenta_bancaria_id IS DISTINCT FROM destino_cuenta_bancaria_id
  ),
  CONSTRAINT ck_traslado_anulado CHECK (
       (estado = 'VIGENTE' AND anulado_en IS NULL AND asiento_anulacion_id IS NULL)
    OR (estado = 'ANULADO' AND anulado_en IS NOT NULL AND anulado_por IS NOT NULL
                           AND asiento_anulacion_id IS NOT NULL
                           AND length(btrim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

CREATE INDEX ix_traslado_fecha ON traslado (empresa_id, fecha DESC);

CREATE TABLE traslado_consecutivo (
  empresa_id         uuid PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  consecutivo_actual int  NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0)
);

-- ── RLS y permisos ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['traslado', 'traslado_consecutivo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END $$;
GRANT UPDATE (estado, motivo_anulacion, anulado_en, anulado_por, asiento_anulacion_id,
              gmf, gmf_movimiento_id)
  ON traslado TO gestion_app, gestion_provision;
GRANT UPDATE ON traslado_consecutivo TO gestion_app, gestion_provision;
