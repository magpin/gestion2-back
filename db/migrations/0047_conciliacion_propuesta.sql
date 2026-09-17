-- 0047 — La conciliación que propone.
--
-- Paso 16 de `docs/planes/ajustes-16-sep.md` (punto 21). Tres partes:
--
--   A. Subir el extracto: de dónde salió cada línea, qué archivo, con qué
--      mapeo de columnas, y la referencia de los dos lados para poder cruzar.
--   B. El grupo de conciliación (decisión 2): lo que se cruza son SUMAS, no
--      renglones. Una línea del banco de $510.000 se explica con el cheque de
--      $500.000 más la comisión de $10.000; un abono de $995.000 con la
--      consignación de $1.000.000 menos la comisión. Reemplaza al
--      `extracto_linea.banco_movimiento_id` de la 0035, que solo sabía de uno
--      contra uno y por eso dejaba aparear valores distintos.
--   C. Las reglas del extracto (decisión 4): "las líneas que dicen GMF son
--      4×1000 y van contra tal cuenta". El sistema no calcula el gravamen —lo
--      liquida el banco, que es el agente retenedor—; lo reconoce en el
--      extracto y lo registra con el valor que el banco cobró.

-- =============================================================================
-- A. Subir el extracto
-- =============================================================================

ALTER TABLE extracto_linea
  ADD COLUMN referencia   text,
  ADD COLUMN origen       text NOT NULL DEFAULT 'MANUAL'
                          CHECK (origen IN ('MANUAL', 'IMPORTADA')),
  -- "La fila 37 del Excel": para que un error señale el renglón del archivo.
  ADD COLUMN fila_archivo integer CHECK (fila_archivo > 0),
  -- Por qué una línea queda sin cruzar al cerrar: un error del banco que se
  -- le reclama. No se ajusta el libro por eso; la nota lo explica.
  ADD COLUMN nota         text CHECK (nota IS NULL OR length(btrim(nota)) > 0),
  ADD CONSTRAINT ck_extracto_linea_fila CHECK (
    (origen = 'MANUAL' AND fila_archivo IS NULL) OR
    (origen = 'IMPORTADA' AND fila_archivo IS NOT NULL)
  ),
  -- Para la FK compuesta de `conciliacion_partida`.
  ADD CONSTRAINT uq_extracto_linea_id_empresa UNIQUE (id, empresa_id);

ALTER TABLE extracto_bancario
  ADD COLUMN archivo_nombre text,
  -- SHA-256 del archivo, en hexadecimal. El mismo archivo dos veces en la
  -- misma cuenta se rechaza: duplicaría todas las líneas.
  ADD COLUMN archivo_huella text CHECK (archivo_huella ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_extracto_archivo CHECK (
    (archivo_nombre IS NULL) = (archivo_huella IS NULL)
  ),
  ADD CONSTRAINT uq_extracto_archivo UNIQUE (cuenta_bancaria_id, archivo_huella);

-- El mapeo de columnas del último extracto subido: el primer mes se arma, los
-- siguientes ya viene. Lo interpreta el frontend; la base solo exige que sea un
-- objeto.
ALTER TABLE cuenta_bancaria
  ADD COLUMN formato_extracto jsonb
    CHECK (formato_extracto IS NULL OR jsonb_typeof(formato_extracto) = 'object');

-- Número de cheque, de aprobación o de transacción. Se fija al registrar el
-- movimiento, como todo lo demás del hecho.
ALTER TABLE banco_movimiento
  ADD COLUMN referencia text CHECK (referencia IS NULL OR length(btrim(referencia)) > 0);

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
         NEW.tercero_id, NEW.saldo_valor, NEW.asiento_id, NEW.creado_por,
         NEW.referencia)
     IS DISTINCT FROM
     ROW(OLD.empresa_id, OLD.cuenta_bancaria_id, OLD.fecha, OLD.tipo,
         OLD.valor, OLD.concepto, OLD.origen_tipo, OLD.origen_id,
         OLD.tercero_id, OLD.saldo_valor, OLD.asiento_id, OLD.creado_por,
         OLD.referencia) THEN
    RAISE EXCEPTION
      'Un movimiento de banco no se edita: se corrige con el movimiento contrario.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- B. El grupo de conciliación
-- =============================================================================

-- Un cruce: unas líneas del extracto explican unos movimientos del libro. La
-- regla de que las dos sumas sean iguales (con signo: crédito y entrada suman,
-- débito y salida restan) la aplica ExtractoService al crear el grupo, en la
-- misma transacción; acá no se puede expresar porque cruza filas.
--
-- Deshacer no borra: marca el grupo y sus partidas, y quién lo deshizo queda.
CREATE TABLE conciliacion_grupo (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  extracto_id  uuid        NOT NULL,

  -- Por qué se cruzó. ANTERIOR: pares hechos antes de esta migración, de los
  -- que no quedó quién.
  criterio     text        NOT NULL CHECK (criterio IN (
                             'REFERENCIA', 'MISMA_FECHA', 'FECHA_CERCANA',
                             'MANUAL', 'REGISTRADA', 'ANTERIOR'
                           )),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  creado_por   uuid        REFERENCES usuario (id) ON DELETE RESTRICT,

  deshecho_en  timestamptz,
  deshecho_por uuid        REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT uq_conciliacion_grupo_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_conciliacion_grupo_extracto
    FOREIGN KEY (extracto_id, empresa_id)
    REFERENCES extracto_bancario (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_conciliacion_grupo_autor CHECK (
    criterio = 'ANTERIOR' OR creado_por IS NOT NULL
  ),
  CONSTRAINT ck_conciliacion_grupo_deshecho CHECK (
    (deshecho_en IS NULL) = (deshecho_por IS NULL)
  )
);

CREATE INDEX ix_conciliacion_grupo_extracto ON conciliacion_grupo (empresa_id, extracto_id);

COMMENT ON TABLE conciliacion_grupo IS
  'Un cruce entre líneas del extracto y movimientos del libro cuyas sumas con signo son iguales. Uno contra uno es el caso común, no el único. Deshacer lo marca, no lo borra.';

-- Cada miembro del grupo: una línea O un movimiento. `vigente` va copiado del
-- grupo para que el índice único parcial pueda decir "un renglón está en un
-- solo cruce vigente a la vez".
CREATE TABLE conciliacion_partida (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid    NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  grupo_id            uuid    NOT NULL,
  extracto_linea_id   uuid,
  banco_movimiento_id uuid,
  vigente             boolean NOT NULL DEFAULT true,

  CONSTRAINT fk_conciliacion_partida_grupo
    FOREIGN KEY (grupo_id, empresa_id)
    REFERENCES conciliacion_grupo (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_conciliacion_partida_linea
    FOREIGN KEY (extracto_linea_id, empresa_id)
    REFERENCES extracto_linea (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_conciliacion_partida_movimiento
    FOREIGN KEY (banco_movimiento_id, empresa_id)
    REFERENCES banco_movimiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_conciliacion_partida_una CHECK (
    (extracto_linea_id IS NULL) <> (banco_movimiento_id IS NULL)
  )
);

CREATE INDEX ix_conciliacion_partida_grupo ON conciliacion_partida (empresa_id, grupo_id);
CREATE UNIQUE INDEX uq_conciliacion_partida_linea
  ON conciliacion_partida (extracto_linea_id) WHERE vigente AND extracto_linea_id IS NOT NULL;
CREATE UNIQUE INDEX uq_conciliacion_partida_movimiento
  ON conciliacion_partida (banco_movimiento_id) WHERE vigente AND banco_movimiento_id IS NOT NULL;

-- Los pares que ya existían pasan a ser grupos de uno contra uno.
DO $$
DECLARE
  l record;
  g uuid;
BEGIN
  FOR l IN
    SELECT el.id, el.empresa_id, el.extracto_id, el.banco_movimiento_id, eb.conciliado_por
      FROM extracto_linea el
      JOIN extracto_bancario eb ON eb.id = el.extracto_id
     WHERE el.banco_movimiento_id IS NOT NULL
  LOOP
    INSERT INTO conciliacion_grupo (empresa_id, extracto_id, criterio, creado_por)
    VALUES (l.empresa_id, l.extracto_id, 'ANTERIOR', l.conciliado_por)
    RETURNING id INTO g;

    INSERT INTO conciliacion_partida (empresa_id, grupo_id, extracto_linea_id)
    VALUES (l.empresa_id, g, l.id);
    INSERT INTO conciliacion_partida (empresa_id, grupo_id, banco_movimiento_id)
    VALUES (l.empresa_id, g, l.banco_movimiento_id);
  END LOOP;
END
$$;

-- Con el grupo, la columna de uno contra uno sobra (y con ella su FK y su
-- UNIQUE). `banco_movimiento.conciliado` se queda: `cerrar` y el índice de
-- pendientes lo usan, y ExtractoService lo mantiene al crear y deshacer grupos.
ALTER TABLE extracto_linea DROP COLUMN banco_movimiento_id;

COMMENT ON TABLE extracto_linea IS
  'Un renglón del extracto, digitado o importado. Se concilia a través de conciliacion_partida. Sin grupo vigente al cerrar es una partida conciliatoria: lo que el banco registró y el libro no.';

-- =============================================================================
-- C. Las reglas del extracto
-- =============================================================================

-- "Si la descripción dice GMF, es el 4×1000 y va contra 511595". Proponen, no
-- registran solas: la pantalla muestra "Registrar las 23 líneas de 4×1000" y
-- una persona confirma.
CREATE TABLE extracto_regla (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  -- NULL: vale para todas las cuentas bancarias de la empresa.
  cuenta_bancaria_id uuid,

  nombre             text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  -- Alguna de estas palabras en la descripción, sin distinguir mayúsculas ni
  -- tildes. Ej.: {GMF, 4X1000, GRAVAMEN}.
  palabras           text[]      NOT NULL CHECK (cardinality(palabras) > 0),
  tipo_linea         text        NOT NULL CHECK (tipo_linea IN ('DEBITO', 'CREDITO')),
  contra_cuenta_id   uuid        NOT NULL,
  concepto           text        NOT NULL CHECK (length(btrim(concepto)) > 0),

  activa             boolean     NOT NULL DEFAULT true,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  creado_por         uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_extracto_regla_cuenta_bancaria
    FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_extracto_regla_contra_cuenta
    FOREIGN KEY (contra_cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_extracto_regla_empresa ON extracto_regla (empresa_id) WHERE activa;

COMMENT ON TABLE extracto_regla IS
  'Reconoce en el extracto los cargos y abonos que el banco hace solo (4×1000, comisiones, cuota de manejo, intereses) y propone registrarlos contra una cuenta fija. Propone; una persona confirma.';

-- =============================================================================
-- RLS y privilegios
-- =============================================================================
-- Sin DELETE para nadie, como el resto de Tesorería.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conciliacion_grupo', 'conciliacion_partida', 'extracto_regla'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;
