-- =============================================================================
-- 0021_periodo_comprobante — el marco donde van a caer los asientos
-- =============================================================================
-- Antes del libro va lo que lo ordena: en qué mes cae cada asiento, y de dónde
-- sale su número. Las dos cosas tienen que existir ANTES que `asiento`, porque
-- las dos son FK suyas.
--
-- Nada acá guarda un movimiento. Son las dos tablas que le ponen reglas al
-- movimiento que viene en 0022.

-- -----------------------------------------------------------------------------
-- Períodos contables
-- -----------------------------------------------------------------------------
-- Cerrar un mes significa que nadie lo vuelve a tocar. Sin esta tabla "cerrado"
-- sería una fecha en la configuración, y cualquier asiento con fecha vieja
-- entraría igual: la fecha del asiento la escribe quien digita, y quien digita
-- se equivoca de año en enero.
--
-- El mes contable no siempre es el calendario. `empresa_configuracion_contable
-- .mes_cierre_fiscal` ya decide dónde termina el año fiscal; acá cada mes es una
-- fila y el año es el fiscal, no el del almanaque.

CREATE TABLE periodo_contable (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  anio           smallint    NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  mes            smallint    NOT NULL CHECK (mes BETWEEN 1 AND 12),

  -- ABIERTO acepta asientos. CERRADO los rechaza por trigger (ver 0022).
  -- No hay estado intermedio: un periodo "en revision" que igual acepta escritura
  -- es un periodo abierto con otro nombre.
  estado         text        NOT NULL DEFAULT 'ABIERTO'
                             CHECK (estado IN ('ABIERTO', 'CERRADO')),

  -- Quien cerro y cuando. Reabrir un periodo cerrado es un evento excepcional y
  -- tiene que quedar el rastro de quien lo hizo.
  cerrado_en     timestamptz,
  cerrado_por    uuid        REFERENCES usuario (id) ON DELETE RESTRICT,

  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz,

  CONSTRAINT uq_periodo_empresa UNIQUE (empresa_id, anio, mes),

  -- Para la FK compuesta de `asiento`: un asiento no puede caer en el periodo de
  -- otra empresa ni con un bug de la aplicacion de por medio.
  CONSTRAINT uq_periodo_id_empresa UNIQUE (id, empresa_id),

  -- Cerrado exige las dos marcas; abierto no admite ninguna. Un periodo con
  -- fecha de cierre y estado ABIERTO no se sabe leer.
  CONSTRAINT ck_periodo_cierre CHECK (
    (estado = 'CERRADO' AND cerrado_en IS NOT NULL AND cerrado_por IS NOT NULL)
    OR
    (estado = 'ABIERTO' AND cerrado_en IS NULL AND cerrado_por IS NULL)
  )
);

CREATE INDEX ix_periodo_empresa ON periodo_contable (empresa_id, anio, mes);
CREATE INDEX ix_periodo_abierto ON periodo_contable (empresa_id) WHERE estado = 'ABIERTO';

COMMENT ON TABLE periodo_contable IS
  'Mes contable por empresa. CERRADO rechaza asientos por trigger, no por codigo de la aplicacion.';
COMMENT ON COLUMN periodo_contable.anio IS
  'Anio fiscal, que no siempre es el calendario: lo decide empresa_configuracion_contable.mes_cierre_fiscal.';

CREATE TRIGGER tg_periodo_actualizado
  BEFORE UPDATE ON periodo_contable
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Tipos de comprobante
-- -----------------------------------------------------------------------------
-- Los asientos no se numeran en una sola serie corrida. Cada tipo lleva la suya
-- —CD-000145, CI-000032, CE-000210— que es como se pide un comprobante y como lo
-- espera cualquier contador al revisar.
--
-- Es por empresa y no catalogo del sistema: dos empresas del mismo tenant llevan
-- numeraciones independientes, y una puede querer un tipo que la otra no usa.
--
-- EL CONSECUTIVO ES COLUMNA Y NO SEQUENCE, a proposito. Una secuencia no vuelve
-- atras cuando la transaccion se revierte, y dejaria huecos en una numeracion que
-- es fiscal. Acá el numero se toma con UPDATE ... RETURNING dentro de la misma
-- transaccion del asiento: si el asiento no se guarda, el numero tampoco se gasta.

CREATE TABLE empresa_comprobante_tipo (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  -- Corto y en mayusculas: es lo que se escribe al digitar.
  codigo         varchar(6)  NOT NULL CHECK (codigo ~ '^[A-Z0-9]{1,6}$'),
  nombre         text        NOT NULL CHECK (length(btrim(nombre)) > 0),

  -- Qué clase de comprobante es. Decide cuáles puede crear la persona a mano:
  -- APERTURA y CIERRE los produce el sistema al abrir y cerrar el ejercicio, y
  -- digitarlos a mano descuadra el arrastre de saldos.
  naturaleza     text        NOT NULL
                             CHECK (naturaleza IN (
                               'DIARIO',    -- ajustes y movimientos varios
                               'INGRESO',   -- recaudos
                               'EGRESO',    -- pagos
                               'APERTURA',  -- saldos iniciales del ejercicio
                               'CIERRE'     -- cancelacion de resultados
                             )),

  -- Va delante del consecutivo al armar el numero: 'CD' + 145 -> 'CD-000145'.
  prefijo        varchar(4)  NOT NULL CHECK (prefijo ~ '^[A-Z0-9]{1,4}$'),
  consecutivo    integer     NOT NULL DEFAULT 0 CHECK (consecutivo >= 0),

  activo         boolean     NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz,

  CONSTRAINT uq_comprobante_codigo  UNIQUE (empresa_id, codigo),
  CONSTRAINT uq_comprobante_prefijo UNIQUE (empresa_id, prefijo),
  CONSTRAINT uq_comprobante_id_empresa UNIQUE (id, empresa_id)
);

CREATE INDEX ix_comprobante_empresa ON empresa_comprobante_tipo (empresa_id) WHERE activo;

COMMENT ON TABLE empresa_comprobante_tipo IS
  'Series de numeracion de los asientos, una por tipo. Por empresa: dos empresas del mismo tenant numeran aparte.';
COMMENT ON COLUMN empresa_comprobante_tipo.consecutivo IS
  'Columna y no SEQUENCE: un rollback tiene que devolver el numero. Se toma con UPDATE ... RETURNING en la misma transaccion del asiento.';
COMMENT ON COLUMN empresa_comprobante_tipo.naturaleza IS
  'APERTURA y CIERRE los produce el sistema; digitarlos a mano descuadra el arrastre de saldos.';

CREATE TRIGGER tg_comprobante_actualizado
  BEFORE UPDATE ON empresa_comprobante_tipo
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Nada se borra. Un periodo cerrado no se elimina: se reabre, y queda el rastro.
-- Un tipo de comprobante con asientos tampoco: se marca activo = false y deja de
-- ofrecerse al digitar.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['periodo_contable', 'empresa_comprobante_tipo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;
