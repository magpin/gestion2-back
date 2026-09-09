-- =============================================================================
-- 0031_compras — factura de compra
-- =============================================================================
-- Módulo 5 de la secuencia (docs/decisiones/secuencia-modulos.md). El modelo
-- completo, con el porqué de cada decisión, vive en
-- `docs/planes/compras-backend.md`. Resumen para leer el DDL:
--
--   1. `compra_documento`        — la cabecera. Un solo tipo (factura de
--                                  compra): sin cotización ni nota crédito
--                                  de proveedor en este corte.
--   2. `compra_documento_linea`  — sus líneas. El costo de cada una es un
--                                  dato de la factura del proveedor, no del
--                                  catálogo — a diferencia de una venta.
--   3. `compra_retencion`        — retención en la fuente practicada, una
--                                  fila por concepto. Base y valor son
--                                  manuales: este corte no calcula tarifas.
--
-- No numeramos la compra: `numero_factura_proveedor` es el número que el
-- PROVEEDOR le puso a su factura, dato externo. `UNIQUE (empresa_id,
-- tercero_id, numero_factura_proveedor)` evita registrar la misma factura
-- dos veces por error.

-- -----------------------------------------------------------------------------
-- Compra_documento — la cabecera
-- -----------------------------------------------------------------------------
CREATE TABLE compra_documento (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  tercero_id                uuid          NOT NULL,
  fecha                     date          NOT NULL,
  numero_factura_proveedor  text          NOT NULL
                                          CHECK (length(btrim(numero_factura_proveedor)) > 0),

  -- Nace EMITIDA siempre: a diferencia de una cotización, una compra no
  -- tiene versión "borrador" — se registra o no se registra.
  estado                    text          NOT NULL DEFAULT 'EMITIDA'
                                          CHECK (estado IN ('EMITIDA', 'ANULADA')),

  subtotal                  numeric(18,2) NOT NULL CHECK (subtotal >= 0),
  total_iva                 numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_iva >= 0),
  total                     numeric(18,2) NOT NULL CHECK (total >= 0),
  total_retenciones         numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_retenciones >= 0),
  -- Lo que efectivamente se le debe al proveedor: lo retenido ya no se le
  -- debe a él, se le debe a la DIAN.
  neto_a_pagar              numeric(18,2) NOT NULL CHECK (neto_a_pagar >= 0),

  -- Siempre resuelto al insertar, igual que en una factura de venta: el
  -- asiento se arma y se guarda ANTES que el documento.
  asiento_id                uuid          NOT NULL,

  motivo_anulacion          text,
  anulado_en                timestamptz,
  anulado_por               uuid          REFERENCES usuario (id) ON DELETE RESTRICT,

  creado_en                 timestamptz   NOT NULL DEFAULT now(),
  creado_por                uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT uq_compra_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT uq_compra_numero_proveedor
    UNIQUE (empresa_id, tercero_id, numero_factura_proveedor),
  CONSTRAINT fk_compra_tercero
    FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_compra_asiento
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT ck_compra_total CHECK (total = subtotal + total_iva),
  CONSTRAINT ck_compra_neto CHECK (neto_a_pagar = total - total_retenciones),
  -- Las cuatro columnas de anulación van juntas o no va ninguna, mismo
  -- principio que `ck_asiento_anulacion`/`ck_venta_anulacion`.
  CONSTRAINT ck_compra_anulacion CHECK (
    (estado = 'ANULADA'
      AND motivo_anulacion IS NOT NULL AND length(btrim(motivo_anulacion)) > 0
      AND anulado_en  IS NOT NULL
      AND anulado_por IS NOT NULL)
    OR
    (estado <> 'ANULADA'
      AND motivo_anulacion IS NULL
      AND anulado_en  IS NULL
      AND anulado_por IS NULL)
  )
);

CREATE INDEX ix_compra_tercero ON compra_documento (empresa_id, tercero_id, fecha);

COMMENT ON TABLE compra_documento IS
  'Factura de compra registrada. Una vez EMITIDA no se edita: se anula (estado=ANULADA, motivo obligatorio) y se corrige con un documento nuevo, igual que asiento y venta_documento.';
COMMENT ON COLUMN compra_documento.numero_factura_proveedor IS
  'El número que el proveedor le puso a SU factura — dato externo, no un consecutivo nuestro.';
COMMENT ON COLUMN compra_documento.neto_a_pagar IS
  'total - total_retenciones: lo que efectivamente se le paga al proveedor. Lo retenido ya no se le debe a él, se le debe a la DIAN.';

-- Sin `actualizado_en` ni trigger genérico, mismo criterio que `venta_documento`:
-- el único UPDATE que recibe esta tabla es la anulación, que ya tiene su
-- propio `anulado_en`.

-- -----------------------------------------------------------------------------
-- Compra_documento_linea — sus líneas (el HECHO, como venta_documento_linea)
-- -----------------------------------------------------------------------------
CREATE TABLE compra_documento_linea (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  compra_documento_id uuid          NOT NULL,

  orden               smallint      NOT NULL,
  producto_id         uuid          NOT NULL,

  cantidad            numeric(18,6) NOT NULL CHECK (cantidad > 0),
  -- Precisión de kardex (producto_movimiento.costo_unitario), no de moneda:
  -- este valor alimenta directo a calcularEntrada().
  costo_unitario      numeric(18,6) NOT NULL CHECK (costo_unitario >= 0),
  iva_tarifa          numeric(5,2)  NOT NULL CHECK (iva_tarifa IN (0, 5, 19)),

  subtotal            numeric(18,2) NOT NULL CHECK (subtotal >= 0),
  iva_valor           numeric(18,2) NOT NULL DEFAULT 0 CHECK (iva_valor >= 0),
  total               numeric(18,2) NOT NULL CHECK (total >= 0),

  -- Si el IVA de esta línea no es descontable (empresa no responsable), se
  -- sumó al costo que entró al kardex: trazabilidad de por qué el costo que
  -- ve el kardex no es igual a `costo_unitario` cuando esto es `false`.
  iva_descontable     boolean       NOT NULL,

  creado_en           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT fk_compra_linea_documento
    FOREIGN KEY (compra_documento_id, empresa_id)
    REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_compra_linea_producto
    FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT uq_compra_linea_orden UNIQUE (compra_documento_id, orden),

  -- El motor no confía en que la aplicación sume bien: lo verifica. Mismo
  -- espíritu que `ck_linea_subtotal`/`ck_linea_iva`/`ck_linea_total` de
  -- `venta_documento_linea`.
  CONSTRAINT ck_compra_linea_subtotal CHECK (subtotal = round(cantidad * costo_unitario, 2)),
  CONSTRAINT ck_compra_linea_iva CHECK (iva_valor = round(subtotal * iva_tarifa / 100, 2)),
  CONSTRAINT ck_compra_linea_total CHECK (total = subtotal + iva_valor)
);

CREATE INDEX ix_compra_linea_documento ON compra_documento_linea (compra_documento_id);
CREATE INDEX ix_compra_linea_producto  ON compra_documento_linea (producto_id);

COMMENT ON TABLE compra_documento_linea IS
  'Las líneas de una compra. Nunca se editan ni se borran, igual que venta_documento_linea.';

-- Nunca se edita ni se borra. La función ya existe (0022) y se reusa igual
-- que ya hizo `inventario` y `ventas` con `producto_movimiento`/
-- `venta_documento_linea`.
CREATE TRIGGER tg_compra_linea_inmutable BEFORE UPDATE OR DELETE ON compra_documento_linea
  FOR EACH ROW EXECUTE FUNCTION fn_linea_inmutable();

-- -----------------------------------------------------------------------------
-- Compra_retencion — la retención practicada, una fila por concepto
-- -----------------------------------------------------------------------------
CREATE TABLE compra_retencion (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  compra_documento_id uuid          NOT NULL,

  -- Los seis conceptos que ya siembra `plan-cuentas.reglas.ts` (sufijos 15,
  -- 20, 25, 30, 40, 70 de la cuenta 2365). ReteIVA/ReteICA quedan fuera de
  -- este corte — ver "Qué NO entra" en el plan.
  concepto            text          NOT NULL CHECK (concepto IN
                        ('HONORARIOS', 'COMISIONES', 'SERVICIOS',
                         'ARRENDAMIENTOS', 'COMPRAS', 'OTROS')),
  -- La cuenta 2365xx resuelta al momento — trazabilidad, igual que
  -- `asiento_linea.cuenta_id` guarda a cuál cuenta se acreditó.
  cuenta_id           uuid          NOT NULL,
  base                numeric(18,2) NOT NULL CHECK (base > 0),
  valor               numeric(18,2) NOT NULL CHECK (valor > 0),

  creado_en           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT fk_compra_retencion_documento
    FOREIGN KEY (compra_documento_id, empresa_id)
    REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_compra_retencion_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  -- No se practica el mismo concepto dos veces sobre la misma factura.
  CONSTRAINT uq_compra_retencion_concepto UNIQUE (compra_documento_id, concepto)
);

CREATE INDEX ix_compra_retencion_documento ON compra_retencion (compra_documento_id);

COMMENT ON TABLE compra_retencion IS
  'Retenciones en la fuente practicadas sobre una compra, una fila por concepto. Base y valor son manuales: este corte no calcula tarifas ni bases mínimas en UVT.';

-- Nunca se edita ni se borra, mismo principio que `compra_documento_linea`.
CREATE TRIGGER tg_compra_retencion_inmutable BEFORE UPDATE OR DELETE ON compra_retencion
  FOR EACH ROW EXECUTE FUNCTION fn_linea_inmutable();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- `compra_documento` acepta UPDATE (solo para anular, igual que
-- `venta_documento`/`asiento`). `compra_documento_linea` y `compra_retencion`
-- no: son un hecho, como `venta_documento_linea`.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compra_documento', 'compra_documento_linea', 'compra_retencion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON compra_documento        TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON compra_documento_linea  TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON compra_retencion        TO gestion_app, gestion_provision;
