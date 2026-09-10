-- =============================================================================
-- 0033_caja — el efectivo: maestro, libro, arqueo y la cuenta de diferencia
-- =============================================================================
-- Parte A de Caja y Bancos (módulo 7 de la secuencia), Fase 1 del plan
-- (docs/planes/caja-bancos-backend.md). Cuatro tablas de un mismo módulo,
-- ninguna tiene sentido sin las otras tres:
--
--   1. `caja`               — el maestro. Un punto físico de efectivo: una
--                             por sede (arqueo por punto de venta) o el
--                             fondo fijo de caja menor, sin sede propia.
--   2. `caja_configuracion` — la cuenta de diferencia de arqueo, elegida
--                             una sola vez. Mismo patrón que
--                             `inventario_configuracion` (0025).
--   3. `caja_movimiento`    — el libro. Un hecho, como `producto_movimiento`
--                             (0025): se inserta y no se toca, con el saldo
--                             DESPUÉS del movimiento ya congelado en la fila.
--   4. `caja_arqueo`        — el cuadre diario. Acá vive "lo de hoy es el
--                             inicio de mañana": una sola caja no puede
--                             tener dos arqueos abiertos a la vez.
--
-- Bancos (extracto, conciliación) NO vive acá: es una migración aparte
-- (0034), con su propia cadencia de cuadre. Ver la sección "Corrección al
-- planteamiento anterior" del plan para el porqué de la separación.

-- -----------------------------------------------------------------------------
-- Caja — el maestro
-- -----------------------------------------------------------------------------
CREATE TABLE caja (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  nombre         text          NOT NULL CHECK (length(btrim(nombre)) > 0),
  tipo           text          NOT NULL CHECK (tipo IN ('PRINCIPAL', 'MENOR')),

  -- PRINCIPAL vive en una sede (el arqueo es por punto de venta, mismo
  -- criterio que ya usa el plan de cuentas al sembrar "Caja - {sede}").
  -- MENOR es el fondo fijo de la empresa entera, sin sede propia.
  sede_id        uuid,

  -- El auxiliar del plan (110505xx por sede, o 110510 caja menor). Elegida
  -- una vez, inmutable: cambiarla dejaría el historial de movimientos
  -- viejo apuntando a una cuenta que esta caja ya no dice usar. Mismo
  -- criterio que producto.cuenta_inventario_id (0025).
  cuenta_id      uuid          NOT NULL,

  activa         boolean       NOT NULL DEFAULT true,
  creado_en      timestamptz   NOT NULL DEFAULT now(),
  creado_por     uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  actualizado_en timestamptz,

  CONSTRAINT uq_caja_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_caja_sede
    FOREIGN KEY (sede_id, empresa_id)
    REFERENCES empresa_sede (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_caja_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,

  -- PRINCIPAL exige sede; MENOR no la tiene, es de toda la empresa.
  CONSTRAINT ck_caja_sede CHECK (
    (tipo = 'PRINCIPAL' AND sede_id IS NOT NULL) OR
    (tipo = 'MENOR' AND sede_id IS NULL)
  )
);

-- Una sola caja PRINCIPAL activa por sede: dos cajas en el mismo punto de
-- venta harían el arqueo ambiguo.
CREATE UNIQUE INDEX ux_caja_principal_por_sede
  ON caja (sede_id) WHERE tipo = 'PRINCIPAL' AND activa;

CREATE INDEX ix_caja_empresa ON caja (empresa_id) WHERE activa;

COMMENT ON TABLE caja IS
  'Un punto físico de efectivo: una por sede (PRINCIPAL) o el fondo fijo de la empresa (MENOR, sin sede). No se elimina: se desactiva, igual que producto, tercero, cuenta.';
COMMENT ON COLUMN caja.cuenta_id IS
  'El auxiliar del plan donde vive ESTA caja. Inmutable: cambiarla dejaría el libro viejo apuntando a una cuenta que la caja ya no dice usar.';

CREATE TRIGGER tg_caja_actualizado
  BEFORE UPDATE ON caja
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Caja_configuracion — la cuenta de diferencia, elegida una sola vez
-- -----------------------------------------------------------------------------
-- Mismo principio que inventario_configuracion (0025): alguien con criterio
-- contable la fija una vez, y el sistema la reusa sin volver a preguntar.
-- Sin ella, cerrar un arqueo con diferencia se rechaza.

CREATE TABLE caja_configuracion (
  empresa_id           uuid        PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  cuenta_diferencia_id uuid,

  creado_en            timestamptz NOT NULL DEFAULT now(),
  actualizado_en       timestamptz,

  CONSTRAINT fk_caja_config_cuenta
    FOREIGN KEY (cuenta_diferencia_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

COMMENT ON TABLE caja_configuracion IS
  'Una fila por empresa. cuenta_diferencia_id es contra que cuenta se ajusta un faltante o sobrante de arqueo (candidata típica: 529910). Nula hasta que CONTADOR o DIRECTOR la elija: sin ella, cerrar un arqueo con diferencia se rechaza.';

CREATE TRIGGER tg_caja_config_actualizado
  BEFORE UPDATE ON caja_configuracion
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Caja_movimiento — el libro (el HECHO)
-- -----------------------------------------------------------------------------
-- Es un hecho, como producto_movimiento: se inserta y no se toca. Corregir
-- un movimiento mal hecho no es editarlo, es registrar el movimiento
-- contrario. El orden que manda es el de DIGITACION (creado_en, id), no el
-- de fecha — mismo criterio que el kardex, mismo motivo: un movimiento con
-- fecha atrasada no reordena el saldo congelado de todo lo posterior.

CREATE TABLE caja_movimiento (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  caja_id        uuid          NOT NULL,

  fecha          date          NOT NULL,
  tipo           text          NOT NULL CHECK (tipo IN
                                  ('SALDO_INICIAL', 'INGRESO', 'EGRESO')),

  -- Siempre positivo. El sentido lo da `tipo`, igual que asiento_linea usa
  -- debito/credito en vez de un signo.
  valor          numeric(18,2) NOT NULL CHECK (valor > 0),
  concepto       text          NOT NULL CHECK (length(btrim(concepto)) > 0),

  -- Con qué se relaciona: el cobro de una factura, el pago de una compra, o
  -- NULL si es manual (un vendedor compra algo con la caja menor, sin
  -- factura de por medio). Mismo patrón polimórfico que asiento.origen_tipo.
  origen_tipo    text          CHECK (origen_tipo IN ('FACTURA_VENTA', 'COMPRA')),
  origen_id      uuid,
  tercero_id     uuid,

  -- El balance DESPUÉS de este movimiento. Congelado, no derivado.
  saldo_valor    numeric(18,2) NOT NULL CHECK (saldo_valor >= 0),

  -- NULL solo en SALDO_INICIAL: la carga inicial (al dar de alta la caja)
  -- no genera asiento automático, mismo motivo que ENTRADA_INICIAL del
  -- kardex — su contrapartida la decide un contador, no una regla que este
  -- módulo pueda adivinar.
  asiento_id     uuid,

  creado_en      timestamptz   NOT NULL DEFAULT now(),
  creado_por     uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_caja_mov_caja
    FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_caja_mov_asiento
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_caja_mov_tercero
    FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT ck_caja_mov_asiento CHECK (
    (tipo = 'SALDO_INICIAL' AND asiento_id IS NULL) OR
    (tipo <> 'SALDO_INICIAL' AND asiento_id IS NOT NULL)
  ),
  CONSTRAINT ck_caja_mov_origen CHECK (
    (origen_tipo IS NULL AND origen_id IS NULL) OR
    (origen_tipo IS NOT NULL AND origen_id IS NOT NULL)
  )
);

CREATE INDEX ix_caja_mov_caja ON caja_movimiento (empresa_id, caja_id, creado_en, id);
CREATE INDEX ix_caja_mov_asiento ON caja_movimiento (asiento_id) WHERE asiento_id IS NOT NULL;

COMMENT ON TABLE caja_movimiento IS
  'El libro de caja. Nunca se edita ni se borra: un movimiento mal hecho se corrige con el movimiento contrario, no editándolo.';
COMMENT ON COLUMN caja_movimiento.asiento_id IS
  'NULL solo en SALDO_INICIAL: esa carga no genera asiento porque su contrapartida es una decisión de migración que un contador valida caso por caso.';

CREATE TRIGGER tg_caja_mov_inmutable
  BEFORE UPDATE OR DELETE ON caja_movimiento
  FOR EACH ROW EXECUTE FUNCTION fn_movimiento_inmutable();

-- -----------------------------------------------------------------------------
-- Caja_arqueo — el cuadre diario
-- -----------------------------------------------------------------------------
-- Acá vive "lo de hoy es el inicio de mañana": el índice único parcial de
-- abajo es lo que de verdad implementa la regla, mismo espíritu que
-- periodo_contable no deja huecos entre meses, pero expresado como "una
-- sola caja no puede tener dos arqueos ABIERTOS a la vez" en vez de exigir
-- un calendario sin saltos — un negocio puede no abrir arqueo un domingo
-- que no operó, y eso no tiene por qué ser un hueco ilegal.

CREATE TABLE caja_arqueo (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  caja_id           uuid          NOT NULL,

  fecha             date          NOT NULL,

  -- Lo que el libro dice que debería haber: el saldo_valor del último
  -- caja_movimiento de esta caja al momento de abrir el arqueo.
  saldo_sistema     numeric(18,2) NOT NULL CHECK (saldo_sistema >= 0),
  -- Lo que la persona contó a mano. Nulo mientras el arqueo sigue abierto.
  saldo_contado     numeric(18,2),
  -- Congelada al cerrar, no recalculada después: un hecho, no un cálculo
  -- que pueda cambiar si algo de atrás se toca.
  diferencia        numeric(18,2),

  estado            text          NOT NULL DEFAULT 'ABIERTO'
                                  CHECK (estado IN ('ABIERTO', 'CERRADO')),
  cerrado_en        timestamptz,
  cerrado_por       uuid          REFERENCES usuario (id) ON DELETE RESTRICT,
  nota              text,

  -- Si cerrar deja una diferencia, el asiento que la ajusta contra
  -- caja_configuracion.cuenta_diferencia_id.
  asiento_ajuste_id uuid,

  creado_en         timestamptz   NOT NULL DEFAULT now(),
  creado_por        uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_arqueo_caja
    FOREIGN KEY (caja_id, empresa_id)
    REFERENCES caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_arqueo_asiento
    FOREIGN KEY (asiento_ajuste_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT ck_arqueo_cierre CHECK (
    (estado = 'CERRADO' AND cerrado_en IS NOT NULL AND cerrado_por IS NOT NULL
       AND saldo_contado IS NOT NULL AND diferencia IS NOT NULL)
    OR
    (estado = 'ABIERTO' AND cerrado_en IS NULL AND cerrado_por IS NULL
       AND saldo_contado IS NULL AND diferencia IS NULL)
  ),
  CONSTRAINT ck_arqueo_diferencia CHECK (
    diferencia IS NULL OR diferencia = saldo_contado - saldo_sistema
  )
);

-- La regla que arrastra: una sola caja, un solo arqueo ABIERTO a la vez.
CREATE UNIQUE INDEX ux_arqueo_abierto ON caja_arqueo (caja_id) WHERE estado = 'ABIERTO';

CREATE INDEX ix_arqueo_caja ON caja_arqueo (empresa_id, caja_id, fecha);

COMMENT ON TABLE caja_arqueo IS
  'El cuadre diario de una caja. ux_arqueo_abierto es la regla real: no se abre uno nuevo mientras el anterior de esa misma caja siga abierto.';

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Nada se borra. Una caja se desactiva, no se elimina; un movimiento o un
-- arqueo, nunca — igual que el resto del sistema.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['caja', 'caja_configuracion', 'caja_movimiento', 'caja_arqueo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;
