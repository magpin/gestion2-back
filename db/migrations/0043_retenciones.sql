-- 0043 — Las retenciones dejan de ser un número que alguien digita.
--
-- Hasta acá el concepto eran seis constantes en el código y la base y el valor
-- los escribía una persona, sin que nada verificara que `valor = base × tarifa`
-- ni que la base superara el mínimo. En 128 compras hay 3 retenciones: o no se
-- usan, o se están omitiendo.
--
-- La retención en la fuente no es un impuesto: es el recaudo anticipado de uno.
-- El agente de retención responde ante la DIAN por el valor **aunque no lo
-- haya practicado** (art. 370 del ET). Por eso no puede depender de que alguien
-- se acuerde.

-- ── La UVT, por año ──────────────────────────────────────────────────────────
-- Las bases mínimas se escriben en UVT justamente para que se actualicen solas
-- cuando la DIAN publica la del año. Es global, no por empresa: la fija una
-- resolución nacional.
--
-- Un documento viejo tiene que seguir explicándose con la UVT de SU año, y por
-- eso esto es una tabla y no una constante.
CREATE TABLE uvt (
  anio       int PRIMARY KEY CHECK (anio BETWEEN 2000 AND 2100),
  valor      numeric(18,2) NOT NULL CHECK (valor > 0),
  creado_en  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON uvt TO gestion_app, gestion_provision;

COMMENT ON TABLE uvt IS
  'El valor de la UVT que la DIAN fija cada año por resolución. Lo carga un contador; el sistema no lo inventa.';

-- ── El catálogo de conceptos ─────────────────────────────────────────────────
-- Por empresa y no global: la de ICA sale del acuerdo del municipio y de la
-- actividad, así que no hay una tabla nacional que sirva para todos.
--
-- Por año porque las tarifas cambian, y un documento de 2025 tiene que seguir
-- explicándose con la tarifa de 2025.
CREATE TABLE retencion_concepto (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  anio                  int NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  -- Las tres retenciones son mecanismos distintos: renta sobre el pago, IVA
  -- sobre el impuesto facturado, ICA sobre el ingreso gravado.
  tipo                  text NOT NULL CHECK (tipo IN ('RENTA', 'IVA', 'ICA')),
  codigo                text NOT NULL CHECK (length(btrim(codigo)) > 0),
  nombre                text NOT NULL CHECK (length(btrim(nombre)) > 0),
  -- En porcentaje, siempre. Una tarifa de ICA en por mil se carga ya dividida
  -- (7 por mil = 0.7), para que el cálculo sea uno solo y no dos.
  tarifa                numeric(7,4) NOT NULL CHECK (tarifa >= 0 AND tarifa <= 100),
  -- La tarifa cuando el beneficiario NO declara renta. Solo aplica a RENTA y
  -- solo a algunos conceptos: servicios generales 4% declarante, 6% si no.
  tarifa_no_declarante  numeric(7,4) CHECK (tarifa_no_declarante IS NULL OR (tarifa_no_declarante >= 0 AND tarifa_no_declarante <= 100)),
  -- En UVT, no en pesos: el valor en pesos cambia cada año y la base no.
  base_minima_uvt       numeric(10,2) NOT NULL DEFAULT 0 CHECK (base_minima_uvt >= 0),
  -- La cuenta 2365xx contra la que se acredita lo retenido.
  cuenta_id             uuid NOT NULL,
  activo                boolean NOT NULL DEFAULT true,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  creado_por            uuid NOT NULL,
  CONSTRAINT uq_retencion_concepto UNIQUE (empresa_id, anio, tipo, codigo),
  CONSTRAINT fk_retencion_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id),
  -- `tarifa_no_declarante` solo tiene sentido en renta: el IVA retenido no
  -- depende de si el proveedor declara, y el ICA tampoco.
  CONSTRAINT ck_retencion_no_declarante
    CHECK (tarifa_no_declarante IS NULL OR tipo = 'RENTA')
);

CREATE INDEX ix_retencion_concepto_anio
  ON retencion_concepto (empresa_id, anio, tipo) WHERE activo;

GRANT SELECT, INSERT, UPDATE ON retencion_concepto TO gestion_app, gestion_provision;

ALTER TABLE retencion_concepto ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_retencion_concepto_aislado ON retencion_concepto
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- ── Si el tercero declara renta ──────────────────────────────────────────────
-- Es lo que decide la tarifa en varios conceptos —servicios 4% o 6%, honorarios
-- 10% u 11%— y hasta hoy no se preguntaba. Por defecto `true`: la mayoría de
-- los proveedores con los que se factura declaran, y equivocarse hacia
-- "declarante" retiene de menos, que se corrige; hacia el otro lado retiene de
-- más, que hay que devolver.
ALTER TABLE tercero
  ADD COLUMN declarante_renta boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN tercero.declarante_renta IS
  'Si declara renta. Decide la tarifa de retefuente en los conceptos que tienen dos.';

-- ── Las retenciones que nos practican a NOSOTROS ─────────────────────────────
-- Cuando el cliente es agente retenedor, nos retiene sobre nuestra factura.
-- **No baja el valor de la factura**: baja lo que nos van a pagar. Lo retenido
-- es un anticipo de nuestro impuesto, o sea un ACTIVO (grupo 1355), no un menor
-- ingreso.
CREATE TABLE venta_retencion (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  venta_documento_id  uuid NOT NULL,
  tipo                text NOT NULL CHECK (tipo IN ('RENTA', 'IVA', 'ICA')),
  concepto            text NOT NULL,
  cuenta_id           uuid NOT NULL,
  base                numeric(18,2) NOT NULL CHECK (base > 0),
  tarifa              numeric(7,4) NOT NULL CHECK (tarifa >= 0),
  valor               numeric(18,2) NOT NULL CHECK (valor > 0),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_venta_retencion_documento
    FOREIGN KEY (venta_documento_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE CASCADE,
  CONSTRAINT fk_venta_retencion_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id),
  -- Una sola retención por tipo y concepto en el mismo documento: dos filas de
  -- "rete-fuente por compras" sobre la misma factura son la misma cargada dos
  -- veces.
  CONSTRAINT uq_venta_retencion UNIQUE (venta_documento_id, tipo, concepto)
);

CREATE INDEX ix_venta_retencion_documento ON venta_retencion (venta_documento_id);

GRANT SELECT, INSERT, UPDATE ON venta_retencion TO gestion_app, gestion_provision;

ALTER TABLE venta_retencion ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_venta_retencion_aislado ON venta_retencion
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

COMMENT ON TABLE venta_retencion IS
  'Lo que el cliente nos retuvo. No baja el total de la factura: baja lo que nos van a pagar, y es un activo nuestro (1355).';
