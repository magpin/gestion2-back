-- Centros de costo, fase 1 (docs/planes/plan-centros-de-costo.md).
--
-- A. El centro se agrupa en dos niveles, se liga a una sede y tiene tipo
--    (productivo, de apoyo, administrativo). Uno por empresa es el de por
--    defecto: a él va lo que ningún documento dice a dónde va.
-- B. Las llaves al centro pasan a ser compuestas con la empresa: con la llave
--    simple, una línea podía apuntar al centro de otra empresa.
-- C. Un centro agrupador no recibe movimientos, como una cuenta que no es
--    auxiliar.
-- D. Los documentos guardan su centro (factura y compra en la cabecera; la
--    compra y el movimiento por concepto, también por renglón).
-- E. El centro por defecto de cada usuario en cada empresa.
--
-- Que el centro esté activo no lo exige la base: un contra-asiento de un
-- documento viejo conserva su centro aunque ya se haya desactivado. Lo que
-- deja de ofrecerse es elegirlo.

-- -----------------------------------------------------------------------------
-- A. empresa_centro_costo
-- -----------------------------------------------------------------------------
ALTER TABLE empresa_centro_costo
  ADD CONSTRAINT uq_centro_costo_id_empresa UNIQUE (id, empresa_id),
  ADD COLUMN padre_id       uuid,
  ADD COLUMN sede_id        uuid,
  ADD COLUMN tipo           text    NOT NULL DEFAULT 'PRODUCTIVO'
    CHECK (tipo IN ('PRODUCTIVO', 'APOYO', 'ADMINISTRATIVO')),
  ADD COLUMN es_por_defecto boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ck_centro_no_es_su_padre CHECK (padre_id IS NULL OR padre_id <> id),
  ADD CONSTRAINT fk_centro_padre FOREIGN KEY (padre_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_centro_sede FOREIGN KEY (sede_id, empresa_id)
    REFERENCES empresa_sede (id, empresa_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX ux_centro_por_defecto
  ON empresa_centro_costo (empresa_id) WHERE es_por_defecto AND activo;

CREATE INDEX ix_centro_padre ON empresa_centro_costo (padre_id) WHERE padre_id IS NOT NULL;

-- Dos niveles: el padre no tiene padre y el hijo no tiene hijos. Un centro con
-- movimientos no pasa a agrupar (sus líneas quedarían en un agrupador), y el
-- de por defecto tampoco: a él caen los movimientos.
CREATE OR REPLACE FUNCTION fn_centro_costo_niveles() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  IF NEW.padre_id IS NOT NULL THEN
    SELECT codigo, nombre, padre_id, es_por_defecto INTO p
      FROM empresa_centro_costo WHERE id = NEW.padre_id;

    IF p.padre_id IS NOT NULL THEN
      RAISE EXCEPTION
        'El centro % (%) ya está dentro de otro: los centros se agrupan en dos niveles.',
        p.codigo, p.nombre
        USING ERRCODE = 'check_violation';
    END IF;
    IF p.es_por_defecto THEN
      RAISE EXCEPTION
        'El centro % (%) es el de por defecto y no puede agrupar otros.',
        p.codigo, p.nombre
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM asiento_linea
                WHERE empresa_id = NEW.empresa_id AND centro_costo_id = NEW.padre_id) THEN
      RAISE EXCEPTION
        'El centro % (%) ya tiene movimientos y no puede agrupar otros.',
        p.codigo, p.nombre
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM empresa_centro_costo WHERE padre_id = NEW.id) THEN
      RAISE EXCEPTION
        'El centro % (%) agrupa otros y no puede quedar dentro de uno.',
        NEW.codigo, NEW.nombre
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.es_por_defecto
     AND EXISTS (SELECT 1 FROM empresa_centro_costo WHERE padre_id = NEW.id) THEN
    RAISE EXCEPTION
      'El centro % (%) agrupa otros y no puede ser el de por defecto.',
      NEW.codigo, NEW.nombre
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_centro_costo_niveles
  BEFORE INSERT OR UPDATE OF padre_id, es_por_defecto ON empresa_centro_costo
  FOR EACH ROW EXECUTE FUNCTION fn_centro_costo_niveles();

-- -----------------------------------------------------------------------------
-- B. asiento_linea: el centro, de la misma empresa
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM asiento_linea l
    JOIN empresa_centro_costo c ON c.id = l.centro_costo_id
   WHERE c.empresa_id <> l.empresa_id;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Hay % líneas de asiento con el centro de costo de otra empresa. Corregirlas antes de migrar.', n;
  END IF;
END
$$;

ALTER TABLE asiento_linea DROP CONSTRAINT fk_linea_centro_costo;
ALTER TABLE asiento_linea ADD CONSTRAINT fk_linea_centro_costo
  FOREIGN KEY (centro_costo_id, empresa_id)
  REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- C. Un agrupador no recibe movimientos
-- -----------------------------------------------------------------------------
-- Igual a la de 0022 más el bloque del agrupador.
CREATE OR REPLACE FUNCTION fn_exigencias_cuenta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  centro record;
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

  IF NEW.centro_costo_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM empresa_centro_costo WHERE padre_id = NEW.centro_costo_id) THEN
    SELECT codigo, nombre INTO centro
      FROM empresa_centro_costo WHERE id = NEW.centro_costo_id;
    RAISE EXCEPTION
      'El centro de costo % (%) agrupa otros y no recibe movimientos. Use uno de los que agrupa.',
      centro.codigo, centro.nombre
      USING ERRCODE = 'check_violation';
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

-- Encender el manejo marca las cuentas 4–7 que existen (CentrosCostoService.
-- fijarManejo); una cuenta de resultado que se cree después nace marcada,
-- venga de donde venga (sugerencia, auxiliar, formulario).
CREATE OR REPLACE FUNCTION fn_cuenta_nueva_exige_centro() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF left(NEW.codigo, 1) IN ('4', '5', '6', '7')
     AND EXISTS (SELECT 1 FROM empresa_configuracion_contable
                  WHERE empresa_id = NEW.empresa_id AND maneja_centro_de_costo) THEN
    NEW.exige_centro_costo := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_cuenta_nueva_exige_centro
  BEFORE INSERT ON empresa_cuenta
  FOR EACH ROW EXECUTE FUNCTION fn_cuenta_nueva_exige_centro();

-- -----------------------------------------------------------------------------
-- D. El centro en los documentos
-- -----------------------------------------------------------------------------
ALTER TABLE venta_documento ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_venta_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE compra_documento ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_compra_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE compra_documento_linea ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_compra_linea_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE movimiento_concepto ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_mc_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE movimiento_concepto_linea ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_mc_linea_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

-- La regla del extracto («las líneas que dicen GMF…») dice también a qué centro.
ALTER TABLE extracto_regla ADD COLUMN centro_costo_id uuid,
  ADD CONSTRAINT fk_extracto_regla_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- F. Repartos: un gasto común entre varios centros (fase 8, D6)
-- -----------------------------------------------------------------------------
-- «Arriendo: 60 % Norte, 40 % Sur». Al registrar, el renglón se parte en uno
-- por centro; el último absorbe el redondeo. La base (metros, empleados) se
-- anota para que el contador pueda justificar los porcentajes.
CREATE TABLE centro_costo_reparto (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  nombre         text        NOT NULL CHECK (length(btrim(nombre)) > 1),
  base           text,
  activo         boolean     NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz,
  CONSTRAINT uq_reparto_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT uq_reparto_nombre UNIQUE (empresa_id, nombre)
);

CREATE TABLE centro_costo_reparto_linea (
  reparto_id      uuid         NOT NULL,
  empresa_id      uuid         NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  orden           smallint     NOT NULL CHECK (orden >= 1),
  centro_costo_id uuid         NOT NULL,
  porcentaje      numeric(7,4) NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
  PRIMARY KEY (reparto_id, orden),
  CONSTRAINT uq_reparto_centro UNIQUE (reparto_id, centro_costo_id),
  CONSTRAINT fk_reparto_linea_reparto FOREIGN KEY (reparto_id, empresa_id)
    REFERENCES centro_costo_reparto (id, empresa_id) ON DELETE CASCADE,
  CONSTRAINT fk_reparto_linea_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT
);

CREATE TRIGGER tg_reparto_actualizado
  BEFORE UPDATE ON centro_costo_reparto
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['centro_costo_reparto', 'centro_costo_reparto_linea'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislada ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END
$$;
GRANT SELECT, INSERT, UPDATE ON centro_costo_reparto TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, DELETE ON centro_costo_reparto_linea TO gestion_app, gestion_provision;

-- El renglón de compra que se repartió guarda con qué reparto, para que la
-- nota que lo devuelve lo reparta igual.
ALTER TABLE compra_documento_linea ADD COLUMN reparto_id uuid,
  ADD CONSTRAINT fk_compra_linea_reparto FOREIGN KEY (reparto_id, empresa_id)
    REFERENCES centro_costo_reparto (id, empresa_id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- E. El centro por defecto de cada usuario
-- -----------------------------------------------------------------------------
-- No va en `usuario_empresa_rol`: ahí hay una fila por rol y el centro se
-- repetiría en cada una.
CREATE TABLE usuario_empresa_centro (
  usuario_id      uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  empresa_id      uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  centro_costo_id uuid        NOT NULL,
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, empresa_id),
  CONSTRAINT fk_uec_centro FOREIGN KEY (centro_costo_id, empresa_id)
    REFERENCES empresa_centro_costo (id, empresa_id) ON DELETE RESTRICT
);

ALTER TABLE usuario_empresa_centro ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_empresa_centro FORCE ROW LEVEL SECURITY;
CREATE POLICY p_usuario_empresa_centro_aislado ON usuario_empresa_centro
  USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON usuario_empresa_centro TO gestion_app, gestion_provision;
