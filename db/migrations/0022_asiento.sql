-- =============================================================================
-- 0022_asiento — el libro
-- =============================================================================
-- Acá empieza la contabilidad. Todo lo anterior describía a la empresa; esto
-- registra lo que le pasa.
--
-- TRES REGLAS QUE NO LAS SOSTIENE LA APLICACIÓN, LAS SOSTIENE LA BASE:
--
--   1. Todo asiento cuadra. Débitos = créditos, verificado al COMMIT.
--   2. En un período cerrado no se escribe.
--   3. Una cuenta que exige tercero, centro de costo o base gravable, los exige.
--      Son las tres banderas que 0016 sembró y que hasta hoy nadie leía.
--
-- Van en la base y no en el servicio porque un asiento descuadrado no se corrige
-- editando: se corrige con otro asiento, y para entonces ya está en el libro.

-- -----------------------------------------------------------------------------
-- Asiento — la cabecera
-- -----------------------------------------------------------------------------
-- Es el hecho contable: fecha, número, explicación. Sin cabecera las líneas son
-- números sueltos que nadie puede auditar.
--
-- `total_debito` y `total_credito` repiten lo que suman las líneas a propósito:
-- sin eso, pintar el libro diario obliga a sumar las líneas de cada asiento en
-- cada consulta. El trigger diferido de más abajo garantiza que no mientan.

CREATE TABLE asiento (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  comprobante_tipo_id uuid        NOT NULL,
  -- El número ya armado: 'CD-000145'. Se guarda hecho y no se arma al leer,
  -- porque es lo que se busca y lo que se imprime.
  numero              varchar(20) NOT NULL CHECK (length(btrim(numero)) > 0),

  -- La fecha del hecho, no la de digitación. Decide en qué período cae.
  fecha               date        NOT NULL,
  periodo_id          uuid        NOT NULL,

  -- Por qué existe este asiento, en palabras. Es lo primero que lee quien
  -- audita, y un asiento sin glosa obliga a reconstruir el motivo de las líneas.
  glosa               text        NOT NULL CHECK (length(btrim(glosa)) > 0),

  total_debito        numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_debito  >= 0),
  total_credito       numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_credito >= 0),

  -- ANULADO no borra: deja el asiento a la vista y lo saca de los saldos. La
  -- anulación correcta de un asiento ya usado es un contra-asiento, pero un
  -- asiento del día, sin nada colgando, se anula.
  estado              text        NOT NULL DEFAULT 'REGISTRADO'
                                  CHECK (estado IN ('REGISTRADO', 'ANULADO')),

  -- De dónde salió. NULL = lo digitó una persona. Cuando existan ventas y
  -- compras, apuntará al documento que lo generó. La columna va desde ahora
  -- porque agregarla después obliga a rellenar hacia atrás lo que ya se asentó.
  origen_tipo         text        CHECK (origen_tipo IN ('VENTA', 'COMPRA', 'NOMINA', 'AJUSTE_INVENTARIO')),
  origen_id           uuid,

  creado_en           timestamptz NOT NULL DEFAULT now(),
  creado_por          uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  actualizado_en      timestamptz,

  CONSTRAINT uq_asiento_numero UNIQUE (empresa_id, comprobante_tipo_id, numero),
  CONSTRAINT uq_asiento_id_empresa UNIQUE (id, empresa_id),

  -- Las dos FK compuestas: el tipo y el período tienen que ser de la MISMA
  -- empresa que el asiento. Con una FK simple, un id equivocado en la aplicación
  -- numeraría un asiento con la serie de otra empresa y nadie se enteraría.
  CONSTRAINT fk_asiento_comprobante
    FOREIGN KEY (comprobante_tipo_id, empresa_id)
    REFERENCES empresa_comprobante_tipo (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_asiento_periodo
    FOREIGN KEY (periodo_id, empresa_id)
    REFERENCES periodo_contable (id, empresa_id) ON DELETE RESTRICT,

  -- Los dos totales son el mismo número. Es la partida doble en una línea.
  CONSTRAINT ck_asiento_cuadra CHECK (total_debito = total_credito),

  -- La columna polimórfica va completa o vacía, nunca a medias.
  CONSTRAINT ck_asiento_origen CHECK (
    (origen_tipo IS NULL AND origen_id IS NULL)
    OR
    (origen_tipo IS NOT NULL AND origen_id IS NOT NULL)
  )
);

-- Las tres consultas del libro: por fecha (diario), por período (balance) y por
-- el documento que lo generó (rastrear una factura hasta su asiento).
CREATE INDEX ix_asiento_fecha   ON asiento (empresa_id, fecha);
CREATE INDEX ix_asiento_periodo ON asiento (periodo_id);
CREATE INDEX ix_asiento_origen  ON asiento (origen_tipo, origen_id) WHERE origen_id IS NOT NULL;

COMMENT ON TABLE asiento IS
  'Cabecera del comprobante contable. El comprobante de diario ES el asiento: separarlos obliga a mantener dos numeraciones para el mismo papel.';
COMMENT ON COLUMN asiento.fecha IS
  'Fecha del hecho, no de la digitacion. Decide el periodo, y el periodo decide si se puede escribir.';
COMMENT ON COLUMN asiento.origen_tipo IS
  'NULL = asiento manual. Cuando existan ventas y compras apunta al documento que lo genero.';

CREATE TRIGGER tg_asiento_actualizado
  BEFORE UPDATE ON asiento
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Asiento_linea — el detalle
-- -----------------------------------------------------------------------------
-- Donde vive la partida doble. Cada línea toca UNA cuenta con un débito o un
-- crédito, nunca los dos: una línea con las dos patas es dos líneas mal escritas,
-- y hace imposible leer el mayor de una cuenta.

CREATE TABLE asiento_linea (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asiento_id        uuid        NOT NULL REFERENCES asiento (id) ON DELETE RESTRICT,
  empresa_id        uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  -- El orden en que se digitó. Importa: un asiento se lee en el orden en que se
  -- escribió, y reordenarlo por id cambia cómo se entiende.
  orden             smallint    NOT NULL CHECK (orden > 0),

  cuenta_id         uuid        NOT NULL,

  -- Las tres dimensiones. Van o no van según las banderas de la cuenta, y de eso
  -- se encarga el trigger de más abajo.
  tercero_id        uuid,
  centro_costo_id   uuid,
  base_gravable     numeric(18,2) CHECK (base_gravable IS NULL OR base_gravable >= 0),

  -- El detalle de ESTA línea, cuando la glosa del asiento no alcanza.
  detalle           text,

  debito            numeric(18,2) NOT NULL DEFAULT 0 CHECK (debito  >= 0),
  credito           numeric(18,2) NOT NULL DEFAULT 0 CHECK (credito >= 0),

  creado_en         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_linea_orden UNIQUE (asiento_id, orden),

  -- Una pata y solo una. Ni las dos, ni ninguna: una línea en cero no aporta al
  -- asiento y ensucia el mayor de la cuenta.
  CONSTRAINT ck_linea_una_pata CHECK (
    (debito > 0 AND credito = 0) OR (credito > 0 AND debito = 0)
  ),

  -- La cuenta es de la misma empresa que la línea. Se apoya en el
  -- uq_empresa_cuenta_id que 0016 dejó puesto justo para esto.
  CONSTRAINT fk_linea_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT fk_linea_asiento_empresa
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT fk_linea_tercero
    FOREIGN KEY (tercero_id) REFERENCES tercero (id) ON DELETE RESTRICT,
  CONSTRAINT fk_linea_centro_costo
    FOREIGN KEY (centro_costo_id) REFERENCES empresa_centro_costo (id) ON DELETE RESTRICT
);

CREATE INDEX ix_linea_asiento ON asiento_linea (asiento_id);
-- El libro mayor: todos los movimientos de una cuenta, en orden.
CREATE INDEX ix_linea_cuenta  ON asiento_linea (empresa_id, cuenta_id);
-- El auxiliar por tercero: la cartera de un cliente sale de acá, no de una
-- cuenta por cliente. Por eso el tercero es columna y no un auxiliar del PUC.
CREATE INDEX ix_linea_tercero ON asiento_linea (empresa_id, tercero_id) WHERE tercero_id IS NOT NULL;
CREATE INDEX ix_linea_centro  ON asiento_linea (empresa_id, centro_costo_id) WHERE centro_costo_id IS NOT NULL;

COMMENT ON TABLE asiento_linea IS
  'Movimiento contable. Una cuenta, una pata. El tercero y el centro de costo son columnas, no cuentas auxiliares.';
COMMENT ON COLUMN asiento_linea.tercero_id IS
  'Obligatorio si la cuenta tiene exige_tercero. La cartera por cliente se agrupa por esta columna, no abriendo una cuenta por cliente.';

-- -----------------------------------------------------------------------------
-- Saldos por cuenta y período
-- -----------------------------------------------------------------------------
-- Rendimiento, y nada más. El balance de prueba pide por cada cuenta el saldo
-- anterior, los movimientos del mes y el saldo final; calcularlo recorriendo los
-- asientos obliga a leer todo el año cada vez que alguien abre la pantalla.
--
-- Se escribe al cerrar el período. Mientras el período está abierto, el balance
-- se calcula sobre las líneas: es un solo mes y ahí sí alcanza.

CREATE TABLE saldo_cuenta_periodo (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  periodo_id      uuid        NOT NULL,
  cuenta_id       uuid        NOT NULL,

  -- Con qué venía, qué se movió, con qué quedó. Los cuatro se guardan y no se
  -- derivan: el saldo final de un período cerrado es un hecho, y recalcularlo
  -- después contra las líneas de hoy daría otro número si algo se reabrió.
  saldo_inicial   numeric(18,2) NOT NULL DEFAULT 0,
  debitos         numeric(18,2) NOT NULL DEFAULT 0 CHECK (debitos  >= 0),
  creditos        numeric(18,2) NOT NULL DEFAULT 0 CHECK (creditos >= 0),
  saldo_final     numeric(18,2) NOT NULL DEFAULT 0,

  creado_en       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_saldo_cuenta_periodo UNIQUE (periodo_id, cuenta_id),

  CONSTRAINT fk_saldo_periodo
    FOREIGN KEY (periodo_id, empresa_id)
    REFERENCES periodo_contable (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_saldo_cuenta
    FOREIGN KEY (cuenta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_saldo_periodo ON saldo_cuenta_periodo (periodo_id);
CREATE INDEX ix_saldo_cuenta  ON saldo_cuenta_periodo (empresa_id, cuenta_id);

COMMENT ON TABLE saldo_cuenta_periodo IS
  'Saldos congelados al cerrar el periodo. Existe por rendimiento: el balance no puede recorrer el ano entero en cada consulta.';
COMMENT ON COLUMN saldo_cuenta_periodo.saldo_final IS
  'Se guarda, no se deriva: el saldo de un periodo cerrado es un hecho, y recalcularlo despues podria dar otro numero.';

-- =============================================================================
-- Las tres reglas
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. El asiento cuadra
-- -----------------------------------------------------------------------------
-- CONSTRAINT TRIGGER DIFERIDO, y tiene que serlo: durante la carga el asiento
-- está descuadrado por definición —la primera línea entra sola—. Verificar en
-- cada INSERT haría imposible guardar cualquier asiento.
--
-- Al COMMIT compara las líneas contra los totales de la cabecera. Que los dos
-- totales sean iguales entre sí ya lo garantiza ck_asiento_cuadra; lo que falta
-- es que no mientan sobre lo que hay abajo.

CREATE OR REPLACE FUNCTION fn_cuadre_asiento() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_asiento uuid := coalesce(NEW.id, OLD.id);
  v_debito  numeric(18,2);
  v_credito numeric(18,2);
  v_cab_deb numeric(18,2);
  v_cab_cre numeric(18,2);
BEGIN
  SELECT total_debito, total_credito INTO v_cab_deb, v_cab_cre
    FROM asiento WHERE id = v_asiento;

  -- El asiento pudo anularse o no existir ya: sin cabecera no hay nada que cuadrar.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(debito), 0), coalesce(sum(credito), 0)
    INTO v_debito, v_credito
    FROM asiento_linea WHERE asiento_id = v_asiento;

  IF v_debito <> v_credito THEN
    RAISE EXCEPTION
      'El asiento no cuadra: debitos %, creditos %. La diferencia es %.',
      v_debito, v_credito, v_debito - v_credito
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debito <> v_cab_deb OR v_credito <> v_cab_cre THEN
    RAISE EXCEPTION
      'Los totales del asiento no coinciden con sus lineas: cabecera %/%, lineas %/%.',
      v_cab_deb, v_cab_cre, v_debito, v_credito
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION fn_cuadre_asiento() IS
  'Diferido al COMMIT: durante la carga el asiento esta descuadrado por definicion.';

CREATE CONSTRAINT TRIGGER tg_cuadre_asiento
  AFTER INSERT OR UPDATE ON asiento
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_cuadre_asiento();

CREATE CONSTRAINT TRIGGER tg_cuadre_linea
  AFTER INSERT OR UPDATE OR DELETE ON asiento_linea
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_cuadre_asiento();

-- -----------------------------------------------------------------------------
-- 2. En período cerrado no se escribe
-- -----------------------------------------------------------------------------
-- Cerrar un mes es una promesa: los estados financieros que se sacaron de ahí no
-- van a cambiar. Si la regla vive en el servicio, un script, una migración o un
-- endpoint nuevo la saltan sin querer.

CREATE OR REPLACE FUNCTION fn_candado_periodo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_anio   smallint;
  v_mes    smallint;
BEGIN
  SELECT estado, anio, mes INTO v_estado, v_anio, v_mes
    FROM periodo_contable WHERE id = NEW.periodo_id;

  IF v_estado = 'CERRADO' THEN
    RAISE EXCEPTION
      'El periodo %-% esta cerrado. Para corregirlo, reabrilo o registra el ajuste en el periodo abierto.',
      v_anio, lpad(v_mes::text, 2, '0')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_candado_periodo
  BEFORE INSERT OR UPDATE ON asiento
  FOR EACH ROW EXECUTE FUNCTION fn_candado_periodo();

-- -----------------------------------------------------------------------------
-- 3. La cuenta exige lo que dice exigir
-- -----------------------------------------------------------------------------
-- Las tres banderas de empresa_cuenta se sembraron en 0016 y hasta hoy no las
-- leía nadie. Acá empiezan a rechazar movimientos.
--
-- El "por qué" de cada una: una cuenta de cartera sin tercero no se puede cobrar
-- —no se sabe a quién—; un gasto sin centro de costo no se puede repartir; un
-- IVA sin base gravable no se puede declarar, porque el medio magnético pide la
-- base y el impuesto por separado.
--
-- Y una cuarta regla que no es bandera: no se asienta en una cuenta de
-- agrupación. Sumarle a la madre lo que ya suman las hijas cuenta dos veces.

CREATE OR REPLACE FUNCTION fn_exigencias_cuenta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  SELECT codigo, nombre, es_auxiliar, activa,
         exige_tercero, exige_centro_costo, exige_base_gravable
    INTO c
    FROM empresa_cuenta WHERE id = NEW.cuenta_id;

  IF NOT c.es_auxiliar THEN
    RAISE EXCEPTION
      'La cuenta % (%) agrupa y no recibe movimientos. Usa una de sus auxiliares.',
      c.codigo, c.nombre
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT c.activa THEN
    RAISE EXCEPTION
      'La cuenta % (%) esta desactivada y no acepta movimientos nuevos.',
      c.codigo, c.nombre
      USING ERRCODE = 'check_violation';
  END IF;

  IF c.exige_tercero AND NEW.tercero_id IS NULL THEN
    RAISE EXCEPTION
      'La cuenta % (%) exige tercero: sin el no se sabe a quien se le debe ni quien debe.',
      c.codigo, c.nombre
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF c.exige_centro_costo AND NEW.centro_costo_id IS NULL THEN
    RAISE EXCEPTION
      'La cuenta % (%) exige centro de costo: sin el el gasto no se puede repartir.',
      c.codigo, c.nombre
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF c.exige_base_gravable AND NEW.base_gravable IS NULL THEN
    RAISE EXCEPTION
      'La cuenta % (%) exige base gravable: el medio magnetico pide la base y el impuesto por separado.',
      c.codigo, c.nombre
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_exigencias_cuenta
  BEFORE INSERT OR UPDATE ON asiento_linea
  FOR EACH ROW EXECUTE FUNCTION fn_exigencias_cuenta();

-- -----------------------------------------------------------------------------
-- Un asiento registrado no se edita ni se borra
-- -----------------------------------------------------------------------------
-- La corrección contable es un contra-asiento, no un UPDATE. Editar el asiento
-- de ayer cambia unos estados financieros que alguien ya imprimió y firmó.
--
-- Lo único que se puede mover en la cabecera es el estado, para anularlo. Las
-- líneas no se tocan nunca despues del COMMIT.

CREATE OR REPLACE FUNCTION fn_asiento_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Un asiento no se borra. Anulalo, o corregilo con un contra-asiento.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Solo el estado. Todo lo demás quedó escrito.
  IF ROW(NEW.empresa_id, NEW.comprobante_tipo_id, NEW.numero, NEW.fecha,
         NEW.periodo_id, NEW.glosa, NEW.total_debito, NEW.total_credito,
         NEW.origen_tipo, NEW.origen_id)
     IS DISTINCT FROM
     ROW(OLD.empresa_id, OLD.comprobante_tipo_id, OLD.numero, OLD.fecha,
         OLD.periodo_id, OLD.glosa, OLD.total_debito, OLD.total_credito,
         OLD.origen_tipo, OLD.origen_id) THEN
    RAISE EXCEPTION
      'Un asiento registrado no se edita: se anula y se vuelve a hacer, o se corrige con un contra-asiento.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_asiento_inmutable
  BEFORE UPDATE OR DELETE ON asiento
  FOR EACH ROW EXECUTE FUNCTION fn_asiento_inmutable();

CREATE OR REPLACE FUNCTION fn_linea_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Las lineas de un asiento no se editan ni se borran. Anula el asiento y volve a hacerlo.'
    USING ERRCODE = 'check_violation';
END;
$$;

-- Solo después del COMMIT: mientras se arma el asiento, sus líneas se corrigen.
-- El trigger mira `creado_en` contra la transacción en curso —dentro de la misma
-- transacción `now()` no avanza—, así que lo que se escribió en OTRA transacción
-- ya está cerrado.
CREATE OR REPLACE FUNCTION fn_linea_ya_comprometida() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.creado_en < now() THEN
    RETURN fn_linea_inmutable();
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER tg_linea_inmutable
  BEFORE UPDATE OR DELETE ON asiento_linea
  FOR EACH ROW EXECUTE FUNCTION fn_linea_ya_comprometida();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Ningún DELETE, en ninguna de las tres. Es la regla del sistema y acá es donde
-- más pesa: borrar un asiento deja el libro descuadrado y sin rastro de que
-- alguna vez estuvo.
--
-- asiento_linea tampoco lleva UPDATE: una línea escrita no se toca, y el trigger
-- de arriba lo dice con un mensaje que explica qué hacer en su lugar.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asiento', 'asiento_linea', 'saldo_cuenta_periodo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON asiento              TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON asiento_linea        TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON saldo_cuenta_periodo TO gestion_app, gestion_provision;

GRANT EXECUTE ON FUNCTION fn_cuadre_asiento()       TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_candado_periodo()      TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_exigencias_cuenta()    TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_asiento_inmutable()    TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_linea_inmutable()      TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_linea_ya_comprometida() TO gestion_app, gestion_provision;
