-- =============================================================================
-- 0016_empresa_cuenta — plan de cuentas de cada empresa y centros de costo
-- =============================================================================
-- El catálogo del decreto (0015) es igual para todo el mundo y nadie lo edita.
-- Esta tabla es lo contrario: es lo que CADA empresa decidió usar, y ninguna
-- empresa ve la de otra.
--
-- Dos cosas viven acá y no en cuenta_puc:
--
--   1. La SELECCIÓN. Una ferretería no usa 2 139 subcuentas, usa 60. Escoger una
--      cuenta es insertar una fila acá, no marcar un booleano en el catálogo
--      compartido — que es lo que hacía el sistema anterior con cuatro columnas
--      (Activa, ActivaEmpresaServicio, ActivaEmpresaComercial, ActivaEmpresaMixta)
--      de las que solo llegó a llenar una.
--
--   2. Los AUXILIARES. El decreto termina en 6 dígitos. "Banco Bancolombia cuenta
--      de ahorros" o "Sueldos - Wildeman" son de la empresa y viven de 7 dígitos
--      para abajo. También son de la empresa los 6 dígitos que caen en los rangos
--      que el decreto deja libres (2205 proveedores, 4135 comercio, 1435
--      inventarios): ahí el código lo elige quien lleva la contabilidad.
--
-- Por eso codigo_puc apunta al ancestro MÁS PROFUNDO que exista en el catálogo, y
-- no siempre a una subcuenta: para 11050501 es 110505 (6 dígitos), pero para
-- 41350100 es 4135 (4 dígitos), porque 413501 lo inventó la empresa.

CREATE TABLE empresa_cuenta (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid        NOT NULL REFERENCES empresa (id),
  codigo              varchar(20) NOT NULL CHECK (codigo ~ '^[0-9]{1,20}$'),
  nombre              text        NOT NULL CHECK (length(btrim(nombre)) > 0),

  -- Ancestro más profundo del código que sí existe en el Decreto 2650. Es lo que
  -- amarra la cuenta de la empresa a la norma: sin esto un auxiliar sería un
  -- número suelto y no se podría armar un balance ni un medio magnético.
  codigo_puc          varchar(6)  NOT NULL REFERENCES cuenta_puc (codigo),

  naturaleza          text        NOT NULL CHECK (naturaleza IN ('DEBITO', 'CREDITO')),

  -- Padre dentro del plan de la propia empresa. NULL = cuelga directo del catálogo.
  codigo_padre        varchar(20),

  -- true = recibe asientos. false = solo agrupa y suma a sus hijas.
  es_auxiliar         boolean     NOT NULL DEFAULT true,

  -- Exigencias al momento de asentar. Una cuenta de cartera sin tercero no sirve
  -- para cobrar; una de IVA sin base no sirve para declarar.
  exige_tercero       boolean     NOT NULL DEFAULT false,
  exige_centro_costo  boolean     NOT NULL DEFAULT false,
  exige_base_gravable boolean     NOT NULL DEFAULT false,

  activa              boolean     NOT NULL DEFAULT true,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  actualizado_en      timestamptz,

  CONSTRAINT uq_empresa_cuenta UNIQUE (empresa_id, codigo),

  -- Para las FK compuestas de los módulos que vienen: un movimiento contable
  -- referencia (cuenta_id, empresa_id) y así no puede apuntar a la cuenta de otra
  -- empresa ni con un bug de la aplicación de por medio.
  CONSTRAINT uq_empresa_cuenta_id UNIQUE (id, empresa_id),

  -- El código de la empresa tiene que caer DENTRO de su cuenta del decreto.
  -- Esto impide que "41350100" se registre colgando de 1105 por un dedazo.
  CONSTRAINT ck_cuenta_dentro_del_puc CHECK (left(codigo, length(codigo_puc)) = codigo_puc),

  -- Y el padre tiene que ser prefijo propio del hijo.
  CONSTRAINT ck_cuenta_padre_prefijo CHECK (
    codigo_padre IS NULL
    OR (length(codigo_padre) < length(codigo) AND left(codigo, length(codigo_padre)) = codigo_padre)
  ),

  -- El padre existe, es de la misma empresa, y no se puede borrar dejando huérfanos.
  CONSTRAINT fk_empresa_cuenta_padre
    FOREIGN KEY (empresa_id, codigo_padre) REFERENCES empresa_cuenta (empresa_id, codigo)
);

CREATE INDEX ix_empresa_cuenta_empresa ON empresa_cuenta (empresa_id) WHERE activa;
CREATE INDEX ix_empresa_cuenta_puc     ON empresa_cuenta (empresa_id, codigo_puc);
CREATE INDEX ix_empresa_cuenta_padre   ON empresa_cuenta (empresa_id, codigo_padre);

-- Las dos búsquedas del mostrador: por código y por nombre sin tildes.
CREATE INDEX ix_empresa_cuenta_auxiliar ON empresa_cuenta (empresa_id, codigo)
  WHERE es_auxiliar AND activa;
CREATE INDEX ix_empresa_cuenta_nombre ON empresa_cuenta (empresa_id, fn_normalizar(nombre));

COMMENT ON TABLE empresa_cuenta IS
  'Plan de cuentas de una empresa: lo que escogio del Decreto 2650 mas sus auxiliares propios.';
COMMENT ON COLUMN empresa_cuenta.codigo_puc IS
  'Ancestro mas profundo que existe en cuenta_puc. Puede ser de 6, 4 o 2 digitos segun hasta donde llegue el decreto para ese codigo.';
COMMENT ON COLUMN empresa_cuenta.es_auxiliar IS
  'Solo las auxiliares reciben asientos. Una cuenta con hijas nunca deberia serlo.';

-- La naturaleza casi siempre es la del catálogo. Dejarla en blanco la hereda; se
-- puede pasar explícita para los pocos auxiliares de naturaleza contraria.
CREATE OR REPLACE FUNCTION fn_heredar_naturaleza_cuenta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.naturaleza IS NULL THEN
    SELECT naturaleza INTO NEW.naturaleza FROM cuenta_puc WHERE codigo = NEW.codigo_puc;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_empresa_cuenta_naturaleza
  BEFORE INSERT ON empresa_cuenta
  FOR EACH ROW EXECUTE FUNCTION fn_heredar_naturaleza_cuenta();

CREATE TRIGGER tg_empresa_cuenta_actualizado
  BEFORE UPDATE ON empresa_cuenta
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Centros de costo
-- -----------------------------------------------------------------------------
-- empresa_configuracion_contable.maneja_centro_de_costo ya decidía si se usan;
-- faltaba dónde guardarlos. La empresa de la Access tenía dos: Almacén y Taller.
CREATE TABLE empresa_centro_costo (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid        NOT NULL REFERENCES empresa (id),
  codigo         varchar(20) NOT NULL CHECK (length(btrim(codigo)) > 0),
  nombre         text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  activo         boolean     NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz,

  CONSTRAINT uq_centro_costo UNIQUE (empresa_id, codigo)
);

CREATE INDEX ix_centro_costo_empresa ON empresa_centro_costo (empresa_id) WHERE activo;

CREATE TRIGGER tg_centro_costo_actualizado
  BEFORE UPDATE ON empresa_centro_costo
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Nada se borra: una cuenta con movimiento no se puede quitar sin dejar el libro
-- descuadrado. Se marca activa = false y deja de ofrecerse al digitar.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['empresa_cuenta', 'empresa_centro_costo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislada ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gestion_app, gestion_provision', t);
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION fn_heredar_naturaleza_cuenta() TO gestion_app, gestion_provision;
