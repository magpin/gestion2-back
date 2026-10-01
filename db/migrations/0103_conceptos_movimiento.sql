-- =============================================================================
-- 0103 — Conceptos de ingreso y egreso, y lo que necesitan Cobros y Pagos
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 2.
--
-- Un concepto es lo que la persona elige al registrar un ingreso o un gasto
-- —«Arriendo del local», «Abono a capital de créditos»— en vez de una cuenta.
-- Cada uno ya sabe a qué auxiliar va, si toca el resultado y a qué parte del
-- flujo de caja pertenece. Es lo que deja salir el estado de resultados y el
-- flujo de caja del mismo dato.
--
-- Cuelga del plan de cuentas de la empresa, nunca de una cuenta inventada. La
-- cuenta puede quedar vacía: si la empresa abrió varios auxiliares donde el
-- concepto podría ir, el contador elige uno (igual que las cuentas
-- automáticas). Un concepto sin cuenta no se puede usar.
--
-- Además:
--   · `asiento_linea.concepto_id`: la línea recuerda de qué concepto salió. Sin
--     eso no hay flujo de caja por actividad.
--   · `vence` en las facturas de venta y de compra: la cartera y lo que se debe
--     se ordenan por vencimiento, no solo por antigüedad.
--   · La condición de pronto pago de la factura del proveedor.
--   · `exenta_gmf` en la cuenta bancaria: la marcada ante el banco no paga 4×1000.

CREATE TABLE concepto_movimiento (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  -- Estable: `GTO-ARRIENDO`. Los del sistema lo traen de la semilla; los que
  -- crea la empresa, `PROPIO-…`.
  codigo          text        NOT NULL CHECK (codigo ~ '^[A-Z0-9-]{3,40}$'),
  nombre          text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  -- Cómo se agrupa en pantalla: «Personal», «Financieros».
  grupo           text        NOT NULL CHECK (length(btrim(grupo)) > 0),
  -- INGRESO → clase 4 · COSTO → 6 y 7 · GASTO → 5 · NO_GASTO → 1, 2 y 3.
  -- Operacional o no se lee de la cuenta (41, 51, 52 frente a 42, 53).
  tipo            text        NOT NULL
                    CHECK (tipo IN ('INGRESO', 'COSTO', 'GASTO', 'NO_GASTO')),
  tipo_flujo      text        NOT NULL DEFAULT 'OPERACION'
                    CHECK (tipo_flujo IN ('OPERACION', 'INVERSION', 'FINANCIACION')),
  cuenta_id       uuid,
  -- Lo usa el sistema por su cuenta (GMF, descuentos por pronto pago,
  -- anticipos): no se ofrece al registrar a mano.
  automatico      boolean     NOT NULL DEFAULT false,
  -- Vino de la semilla: no se borra ni cambia de tipo; la cuenta sí se elige.
  es_sistema      boolean     NOT NULL DEFAULT false,
  -- Palabras con que María lo reconoce en una descripción.
  pistas          text[]      NOT NULL DEFAULT '{}',
  activo          boolean     NOT NULL DEFAULT true,
  orden           smallint    NOT NULL DEFAULT 0,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_concepto_codigo UNIQUE (empresa_id, codigo),
  CONSTRAINT uq_concepto_id UNIQUE (id, empresa_id),
  CONSTRAINT fk_concepto_cuenta FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

-- El mismo nombre no se repite dentro de un tipo: sería elegir a ciegas.
CREATE UNIQUE INDEX ux_concepto_nombre
  ON concepto_movimiento (empresa_id, tipo, lower(nombre));
CREATE INDEX ix_concepto_tipo
  ON concepto_movimiento (empresa_id, tipo) WHERE activo;

ALTER TABLE concepto_movimiento ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepto_movimiento FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_concepto_movimiento_aislado ON concepto_movimiento
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- Sin DELETE: un concepto usado no se borra, se desactiva.
GRANT SELECT, INSERT, UPDATE ON concepto_movimiento TO gestion_app, gestion_provision;

-- ── La línea del asiento recuerda su concepto ────────────────────────────────
ALTER TABLE asiento_linea ADD COLUMN concepto_id uuid;
ALTER TABLE asiento_linea
  ADD CONSTRAINT fk_linea_concepto FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT;
CREATE INDEX ix_linea_concepto ON asiento_linea (concepto_id) WHERE concepto_id IS NOT NULL;

-- ── Vencimientos ─────────────────────────────────────────────────────────────
-- NULL en lo que ya existe: la edad de esa cartera se sigue contando desde la
-- fecha de la factura.
ALTER TABLE venta_documento ADD COLUMN vence date;
ALTER TABLE venta_documento
  ADD CONSTRAINT ck_venta_vence CHECK (vence IS NULL OR vence >= fecha);

ALTER TABLE compra_documento ADD COLUMN vence date;
ALTER TABLE compra_documento
  ADD CONSTRAINT ck_compra_vence CHECK (vence IS NULL OR vence >= fecha);

-- «2 % pagando antes del 30 de septiembre»: la condición que trae la factura
-- del proveedor. Las dos columnas van juntas o ninguna.
ALTER TABLE compra_documento
  ADD COLUMN descuento_pp_pct   numeric(5,2),
  ADD COLUMN descuento_pp_hasta date;
ALTER TABLE compra_documento
  ADD CONSTRAINT ck_compra_descuento_pp CHECK (
    (descuento_pp_pct IS NULL AND descuento_pp_hasta IS NULL)
    OR (descuento_pp_pct > 0 AND descuento_pp_pct < 100
        AND descuento_pp_hasta IS NOT NULL AND descuento_pp_hasta >= fecha)
  );

-- ── Cuenta bancaria exenta del 4×1000 ───────────────────────────────────────
-- Una por titular ante el sistema financiero (art. 879 num. 1 ET). Se marca a
-- mano: el banco lo sabe, el sistema no.
ALTER TABLE cuenta_bancaria ADD COLUMN exenta_gmf boolean NOT NULL DEFAULT false;
