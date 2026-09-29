-- Impuestos: el calendario, la periodicidad de la empresa y sus declaraciones
-- (Fase 1 de docs/planes/plan-pantallas-complementarias.md).
--
-- 1. `calendario_tributario`: ley, como la UVT. Cuándo vence cada obligación
--    por período y por último dígito del NIT (sin el de verificación), o por
--    municipio. La carga la consola; la app solo la lee. Sin fila, la pantalla
--    dice «fecha por confirmar»: el sistema no adivina fechas (PC3).
--
-- 2. `empresa_impuesto_config`: lo que el RUT no dice y cambia el calendario.
--    Por ahora, cada cuánto declara IVA.
--
-- 3. `declaracion`: una por obligación y período. Nace cuando se registra la
--    presentación (número del formulario, fecha, valor y el PDF subido) y pasa
--    a PAGADA con el pago (recibo 490 y el asiento). Antes de eso no existe: el
--    estado «por presentar» o «causándose» se deduce del calendario y del
--    libro. Nada se transmite a la DIAN (PC2).

-- ── 1. Calendario (ley) ─────────────────────────────────────────────────────
CREATE TABLE calendario_tributario (
  id               serial       PRIMARY KEY,
  anio             smallint     NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
  obligacion       text         NOT NULL
                     CHECK (obligacion IN ('RETENCION', 'IVA', 'RETEICA', 'ICA', 'RENTA')),
  -- «2026-09» (mes), «2026-B5» (bimestre), «2026-C3» (cuatrimestre), «2026-T4» (trimestre), «2025» (año).
  periodo          text         NOT NULL CHECK (periodo ~ '^\d{4}(-(0[1-9]|1[0-2]|B[1-6]|C[1-3]|T[1-4]))?$'),
  -- La cuota de la renta (1, 2, 3); NULL cuando la obligación no va por cuotas.
  cuota            smallint     CHECK (cuota BETWEEN 1 AND 3),
  -- El último dígito del NIT, sin el de verificación; NULL si no depende de él.
  digito           smallint     CHECK (digito BETWEEN 0 AND 9),
  -- Para las obligaciones municipales.
  municipio_codigo char(5)      REFERENCES municipio (codigo),
  vence            date         NOT NULL,
  fuente           text         NOT NULL,
  validado_por     text,
  validado_en      date
);

CREATE UNIQUE INDEX uq_calendario_tributario ON calendario_tributario
  (obligacion, periodo, coalesce(cuota, 0), coalesce(digito, -1), coalesce(municipio_codigo, ''));

GRANT SELECT ON calendario_tributario TO gestion_app, gestion_provision;
GRANT INSERT, UPDATE ON calendario_tributario TO gestion_provision;
GRANT USAGE ON SEQUENCE calendario_tributario_id_seq TO gestion_provision;

-- ── 2. Periodicidad de la empresa ───────────────────────────────────────────
CREATE TABLE empresa_impuesto_config (
  empresa_id        uuid         PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  -- Bimestral si los ingresos brutos del año anterior llegaron a 92.000 UVT o
  -- es gran contribuyente; si no, cuatrimestral (art. 600 ET).
  periodicidad_iva  text         CHECK (periodicidad_iva IN ('BIMESTRAL', 'CUATRIMESTRAL')),
  actualizado_en    timestamptz  NOT NULL DEFAULT now(),
  actualizado_por   uuid
);

-- ── 3. Declaraciones ────────────────────────────────────────────────────────
CREATE TABLE declaracion (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  obligacion          text          NOT NULL
                        CHECK (obligacion IN ('RETENCION', 'IVA', 'RETEICA', 'ICA', 'RENTA')),
  periodo             text          NOT NULL CHECK (periodo ~ '^\d{4}(-(0[1-9]|1[0-2]|B[1-6]|C[1-3]|T[1-4]))?$'),
  municipio_codigo    char(5)       REFERENCES municipio (codigo),
  estado              text          NOT NULL CHECK (estado IN ('PRESENTADA', 'PAGADA')),

  -- La presentación, que se hace en MUISCA o en el portal del municipio.
  numero_formulario   text          NOT NULL CHECK (length(trim(numero_formulario)) > 0),
  presentada_el       date          NOT NULL,
  -- Lo que dice el formulario, redondeado al mil (art. 577 ET).
  valor_a_pagar       numeric(18,2) NOT NULL CHECK (valor_a_pagar >= 0),
  -- El vencimiento: del calendario, o el que se digitó si el calendario no lo tiene.
  vence               date,
  archivo_clave       text,
  archivo_nombre      text,

  -- El pago.
  recibo_490          text,
  pagada_el           date,
  medio               text          CHECK (medio IN ('CAJA', 'BANCO')),
  caja_id             uuid,
  cuenta_bancaria_id  uuid,
  intereses           numeric(18,2) NOT NULL DEFAULT 0 CHECK (intereses >= 0),
  asiento_id          uuid,
  movimiento_id       uuid,
  gmf_movimiento_id   uuid,
  gmf                 numeric(18,2) NOT NULL DEFAULT 0 CHECK (gmf >= 0),

  creado_por          uuid          NOT NULL,
  creado_en           timestamptz   NOT NULL DEFAULT now(),
  pagado_por          uuid,

  CONSTRAINT uq_declaracion_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_declaracion_caja FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id),
  CONSTRAINT fk_declaracion_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id),
  CONSTRAINT fk_declaracion_asiento FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id),
  -- Pagada si y solo si tiene todo lo del pago.
  CONSTRAINT ck_declaracion_pago CHECK (
    (estado = 'PAGADA') = (pagada_el IS NOT NULL AND asiento_id IS NOT NULL AND medio IS NOT NULL)
  ),
  CONSTRAINT ck_declaracion_medio CHECK (
    medio IS NULL
    OR (medio = 'CAJA' AND caja_id IS NOT NULL AND cuenta_bancaria_id IS NULL)
    OR (medio = 'BANCO' AND cuenta_bancaria_id IS NOT NULL AND caja_id IS NULL)
  ),
  -- Las municipales llevan municipio; las de la DIAN, no.
  CONSTRAINT ck_declaracion_municipio CHECK (
    (obligacion IN ('RETEICA', 'ICA')) = (municipio_codigo IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_declaracion_periodo ON declaracion
  (empresa_id, obligacion, periodo, coalesce(municipio_codigo, ''));

-- ── RLS y permisos ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['empresa_impuesto_config', 'declaracion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END $$;
GRANT UPDATE (periodicidad_iva, actualizado_en, actualizado_por)
  ON empresa_impuesto_config TO gestion_app, gestion_provision;
-- La presentación se corrige mientras no esté pagada; el pago se escribe una vez.
GRANT UPDATE (estado, numero_formulario, presentada_el, valor_a_pagar, vence,
              archivo_clave, archivo_nombre, recibo_490, pagada_el, medio, caja_id,
              cuenta_bancaria_id, intereses, asiento_id, movimiento_id,
              gmf_movimiento_id, gmf, pagado_por)
  ON declaracion TO gestion_app, gestion_provision;
