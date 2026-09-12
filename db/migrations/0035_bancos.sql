-- =============================================================================
-- 0035_bancos — la cuenta bancaria, su libro, el extracto y la conciliación
-- =============================================================================
-- Parte B de Caja y Bancos (módulo 7 de la secuencia), Fase 2 del plan
-- (docs/planes/caja-bancos-backend.md, detalle de sub-pasos en
-- docs/planes/caja-bancos-fase2.md). Cuatro tablas:
--
--   1. `cuenta_bancaria` — el maestro. Un auxiliar (1110xx) por cuenta:
--                          `uq_cuenta_bancaria_cuenta` es UNIQUE simple, no
--                          compuesto, porque un auxiliar no puede servir a
--                          dos cuentas bancarias a la vez.
--   2. `banco_movimiento` — el libro. Un hecho, como `caja_movimiento`: se
--                          inserta y no se toca. Sin arqueo: el saldo corre
--                          continuo, y `conciliado` marca si ya apareció en
--                          una línea de extracto.
--   3. `extracto_bancario` — la cabecera de lo que el banco dice: un rango
--                          de fechas, no un día. No encadena con el
--                          anterior — el banco lleva su propio calendario.
--   4. `extracto_linea`   — cada renglón del extracto, digitado a mano en
--                          este corte (importar un archivo queda para
--                          después — ver "Qué NO entra" del plan).
--
-- Caja es un arqueo físico (el cierre de hoy es el punto de partida de
-- mañana); Bancos es una conciliación contra un tercero que lleva su
-- propio calendario, y por eso NO tiene esa compuerta secuencial — ver
-- "Corrección al planteamiento anterior" en el plan para el porqué
-- completo de la separación.

-- -----------------------------------------------------------------------------
-- Cuenta_bancaria — el maestro
-- -----------------------------------------------------------------------------
CREATE TABLE cuenta_bancaria (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  banco          text          NOT NULL CHECK (length(btrim(banco)) > 0),
  numero_cuenta  text          NOT NULL CHECK (length(btrim(numero_cuenta)) > 0),
  tipo_cuenta    text          NOT NULL CHECK (tipo_cuenta IN ('AHORROS', 'CORRIENTE')),

  -- El auxiliar bajo 1110 (11100501, 11100502...) que el usuario crea con
  -- "+ Auxiliar" en Plan de Cuentas. Una cuenta bancaria, un auxiliar:
  -- nunca comparten cuenta contable dos bancos distintos.
  cuenta_id      uuid          NOT NULL,

  activa         boolean       NOT NULL DEFAULT true,
  creado_en      timestamptz   NOT NULL DEFAULT now(),
  creado_por     uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  actualizado_en timestamptz,

  CONSTRAINT uq_cuenta_bancaria_numero UNIQUE (empresa_id, banco, numero_cuenta),
  CONSTRAINT uq_cuenta_bancaria_cuenta UNIQUE (cuenta_id),
  CONSTRAINT uq_cuenta_bancaria_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_cuenta_bancaria_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_cuenta_bancaria_empresa ON cuenta_bancaria (empresa_id) WHERE activa;

COMMENT ON TABLE cuenta_bancaria IS
  'Una cuenta bancaria real de la empresa. No se elimina: se desactiva, igual que caja/producto/tercero/cuenta.';
COMMENT ON COLUMN cuenta_bancaria.cuenta_id IS
  'El auxiliar del plan donde vive ESTA cuenta bancaria. UNIQUE simple: un auxiliar no sirve a dos cuentas bancarias a la vez, o su saldo se mezclaría en el mismo mayor.';

CREATE TRIGGER tg_cuenta_bancaria_actualizado
  BEFORE UPDATE ON cuenta_bancaria
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Banco_movimiento — el libro (el HECHO)
-- -----------------------------------------------------------------------------
-- Igual que caja_movimiento: se inserta y no se toca, el orden que manda
-- es el de DIGITACION (creado_en, id), no el de fecha. A diferencia de
-- caja_movimiento, `saldo_valor` NO tiene CHECK (>= 0): una cuenta
-- bancaria puede tener sobregiro, un cajón de efectivo no.

CREATE TABLE banco_movimiento (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  cuenta_bancaria_id uuid          NOT NULL,

  fecha              date          NOT NULL,
  tipo               text          NOT NULL CHECK (tipo IN (
                                     'SALDO_INICIAL', 'CONSIGNACION', 'RETIRO',
                                     'TRANSFERENCIA_ENTRANTE', 'TRANSFERENCIA_SALIENTE',
                                     'NOTA_DEBITO', 'NOTA_CREDITO', 'CHEQUE'
                                   )),

  valor              numeric(18,2) NOT NULL CHECK (valor > 0),
  concepto           text          NOT NULL CHECK (length(btrim(concepto)) > 0),

  -- Con qué se relaciona: el cobro de una factura, el pago de una compra,
  -- o NULL si es manual. Mismo patrón que caja_movimiento.origen_tipo.
  origen_tipo        text          CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA')),
  origen_id          uuid,
  tercero_id         uuid,

  -- El balance DESPUÉS de este movimiento. Congelado, no derivado. SIN
  -- CHECK (>= 0) — ver comentario de la tabla.
  saldo_valor        numeric(18,2) NOT NULL,

  -- NULL solo en SALDO_INICIAL — mismo motivo que caja_movimiento.
  asiento_id         uuid,

  -- Si ya apareció del otro lado, en una línea del extracto.
  conciliado         boolean       NOT NULL DEFAULT false,

  creado_en          timestamptz   NOT NULL DEFAULT now(),
  creado_por         uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT uq_banco_mov_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_banco_mov_cuenta
    FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_banco_mov_asiento
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_banco_mov_tercero
    FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT ck_banco_mov_asiento CHECK (
    (tipo = 'SALDO_INICIAL' AND asiento_id IS NULL) OR
    (tipo <> 'SALDO_INICIAL' AND asiento_id IS NOT NULL)
  ),
  CONSTRAINT ck_banco_mov_origen CHECK (
    (origen_tipo IS NULL AND origen_id IS NULL) OR
    (origen_tipo IS NOT NULL AND origen_id IS NOT NULL)
  )
);

CREATE INDEX ix_banco_mov_cuenta ON banco_movimiento (empresa_id, cuenta_bancaria_id, creado_en, id);
CREATE INDEX ix_banco_mov_sin_conciliar
  ON banco_movimiento (cuenta_bancaria_id) WHERE NOT conciliado;

COMMENT ON TABLE banco_movimiento IS
  'El libro de una cuenta bancaria. No se edita ni se borra, salvo `conciliado` — ver fn_banco_movimiento_inmutable. Sin arqueo: el saldo corre continuo, como el kardex.';
COMMENT ON COLUMN banco_movimiento.saldo_valor IS
  'El saldo DESPUÉS de este movimiento. A diferencia de caja_movimiento.saldo_valor, sin CHECK (>= 0): una cuenta bancaria puede tener sobregiro.';
COMMENT ON COLUMN banco_movimiento.conciliado IS
  'La ÚNICA columna que un UPDATE puede tocar después de insertado — ver fn_banco_movimiento_inmutable. La marca ExtractoService al aparear este movimiento con una línea de extracto.';

-- A diferencia de `fn_movimiento_inmutable` (kardex, caja_movimiento —
-- todo el hecho es fijo desde que se inserta), acá SÍ hay una columna que
-- cambia después: `conciliado`, cuando `ExtractoService` aparea este
-- movimiento con una línea de extracto. El trigger deja pasar ESA
-- columna, y nada más — mismo criterio que `fn_asiento_inmutable` con las
-- cuatro columnas de la anulación.
CREATE OR REPLACE FUNCTION fn_banco_movimiento_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Un movimiento de banco no se borra. Corregilo con el movimiento contrario.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF ROW(NEW.empresa_id, NEW.cuenta_bancaria_id, NEW.fecha, NEW.tipo,
         NEW.valor, NEW.concepto, NEW.origen_tipo, NEW.origen_id,
         NEW.tercero_id, NEW.saldo_valor, NEW.asiento_id, NEW.creado_por)
     IS DISTINCT FROM
     ROW(OLD.empresa_id, OLD.cuenta_bancaria_id, OLD.fecha, OLD.tipo,
         OLD.valor, OLD.concepto, OLD.origen_tipo, OLD.origen_id,
         OLD.tercero_id, OLD.saldo_valor, OLD.asiento_id, OLD.creado_por) THEN
    RAISE EXCEPTION
      'Un movimiento de banco no se edita: se corrige con el movimiento contrario.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_banco_movimiento_inmutable() TO gestion_app, gestion_provision;

CREATE TRIGGER tg_banco_mov_inmutable
  BEFORE UPDATE OR DELETE ON banco_movimiento
  FOR EACH ROW EXECUTE FUNCTION fn_banco_movimiento_inmutable();

-- -----------------------------------------------------------------------------
-- Extracto_bancario — lo que el banco dice
-- -----------------------------------------------------------------------------
CREATE TABLE extracto_bancario (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  cuenta_bancaria_id  uuid          NOT NULL,

  fecha_desde         date          NOT NULL,
  fecha_hasta         date          NOT NULL CHECK (fecha_hasta >= fecha_desde),
  saldo_inicial_banco numeric(18,2) NOT NULL,
  saldo_final_banco   numeric(18,2) NOT NULL,

  estado              text          NOT NULL DEFAULT 'ABIERTO'
                                    CHECK (estado IN ('ABIERTO', 'CONCILIADO')),
  conciliado_en       timestamptz,
  conciliado_por      uuid          REFERENCES usuario (id) ON DELETE RESTRICT,

  creado_en           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_extracto_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_extracto_cuenta
    FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT uq_extracto_rango UNIQUE (cuenta_bancaria_id, fecha_desde, fecha_hasta),

  CONSTRAINT ck_extracto_cierre CHECK (
    (estado = 'CONCILIADO' AND conciliado_en IS NOT NULL AND conciliado_por IS NOT NULL)
    OR
    (estado = 'ABIERTO' AND conciliado_en IS NULL AND conciliado_por IS NULL)
  )
);

CREATE INDEX ix_extracto_cuenta ON extracto_bancario (empresa_id, cuenta_bancaria_id, fecha_desde);

COMMENT ON TABLE extracto_bancario IS
  'Un rango de fechas, no un día — no encadena con el anterior: el banco lleva su propio calendario. CONCILIADO exige cuadrar (ver ExtractoService.cerrar), no solo marcar.';

-- -----------------------------------------------------------------------------
-- Extracto_linea
-- -----------------------------------------------------------------------------
CREATE TABLE extracto_linea (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  extracto_id         uuid          NOT NULL,

  fecha               date          NOT NULL,
  descripcion         text          NOT NULL,
  valor               numeric(18,2) NOT NULL CHECK (valor > 0),
  tipo                text          NOT NULL CHECK (tipo IN ('DEBITO', 'CREDITO')),

  -- El match, cuando existe. Una línea de extracto concilia como mucho un
  -- movimiento del libro, y viceversa.
  banco_movimiento_id uuid,

  creado_en           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT fk_extracto_linea_extracto
    FOREIGN KEY (extracto_id, empresa_id)
    REFERENCES extracto_bancario (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_extracto_linea_movimiento
    FOREIGN KEY (banco_movimiento_id, empresa_id)
    REFERENCES banco_movimiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT uq_extracto_linea_movimiento UNIQUE (banco_movimiento_id)
);

CREATE INDEX ix_extracto_linea_extracto ON extracto_linea (empresa_id, extracto_id);

COMMENT ON TABLE extracto_linea IS
  'Un renglón del extracto, digitado a mano. Sin banco_movimiento_id y sin contrapartida al cerrar el extracto: hay que digitar el movimiento que falta en el libro, o crear uno nuevo contra la cuenta que corresponda a lo que el banco realmente cobró o abonó.';

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Nada se borra. Una cuenta bancaria se desactiva, no se elimina; un
-- movimiento, un extracto o una línea, nunca — igual que el resto del sistema.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cuenta_bancaria', 'banco_movimiento', 'extracto_bancario', 'extracto_linea'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;
