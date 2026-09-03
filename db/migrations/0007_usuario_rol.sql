-- =============================================================================
-- 0007_usuario_rol — quién entra, a qué empresa y con qué permisos
-- =============================================================================
-- Decisión: un usuario pertenece a UN tenant. El caso "misma persona en dos
-- despachos" se resuelve con dos cuentas. Migrar a multi-tenant por usuario más
-- adelante es aditivo (una tabla `usuario_tenant`), no destructivo.

CREATE TABLE usuario (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenant (id),
  email            citext      NOT NULL UNIQUE CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
  nombre_completo  text        NOT NULL,
  hash_password    text        NOT NULL,
  activo           boolean     NOT NULL DEFAULT true,
  ultimo_acceso_en timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz,

  -- Necesaria para la FK compuesta que impide cruzar tenants (ver usuario_empresa_rol).
  CONSTRAINT uq_usuario_id_tenant UNIQUE (id, tenant_id)
);

COMMENT ON COLUMN usuario.email IS
  'Unico global: es la llave de login y la sesion aun no sabe de que tenant es quien intenta entrar.';
COMMENT ON COLUMN usuario.hash_password IS
  'argon2id. Nunca se compara en SQL: la verificacion ocurre en la aplicacion.';

CREATE INDEX ix_usuario_tenant ON usuario (tenant_id) WHERE activo;

CREATE TRIGGER tg_usuario_actualizado
  BEFORE UPDATE ON usuario
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Catálogo de roles — compartido, no por tenant
-- -----------------------------------------------------------------------------
CREATE TABLE rol (
  codigo      text PRIMARY KEY CHECK (codigo ~ '^[A-Z_]{3,30}$'),
  nombre      text NOT NULL,
  descripcion text NOT NULL,
  ambito      text NOT NULL CHECK (ambito IN ('TENANT', 'EMPRESA'))
);

COMMENT ON COLUMN rol.ambito IS
  'TENANT: se ejerce sobre la cuenta entera (administrar empresas, usuarios, suscripcion). EMPRESA: se ejerce dentro de una contabilidad.';

INSERT INTO rol (codigo, nombre, descripcion, ambito) VALUES
  ('ADMIN_TENANT', 'Administrador de la cuenta', 'Crea empresas, invita usuarios y gestiona la suscripcion. No opera contabilidad por si mismo.', 'TENANT'),
  ('DIRECTOR',     'Director',                   'Autoriza excepciones, ve todos los reportes y cierra periodos. No es superusuario.',              'EMPRESA'),
  ('CONTADOR',     'Contador',                   'Registra notas contables, concilia y cierra. Unico que escribe asientos manuales.',                'EMPRESA'),
  ('VENTAS',       'Ventas',                     'Cotiza, vende y consulta cartera.',                                                               'EMPRESA'),
  ('COMPRAS',      'Compras',                    'Registra compras y paga proveedores.',                                                            'EMPRESA'),
  ('INVENTARIO',   'Inventario',                 'Administra productos y ajustes de existencias.',                                                  'EMPRESA'),
  ('CAJA',         'Caja',                       'Cobra, paga y arquea.',                                                                           'EMPRESA'),
  ('CONSULTA',     'Solo lectura',               'Ve informacion, no escribe nada.',                                                                'EMPRESA');

-- -----------------------------------------------------------------------------
-- Acceso: qué usuario entra a qué empresa y con qué rol
-- -----------------------------------------------------------------------------
-- Tener una fila acá ES el permiso de acceso a esa empresa. Sin fila, la empresa
-- no existe para ese usuario.
--
-- Las dos FK compuestas hacen imposible asignarle a un usuario una empresa de otro
-- tenant. La regla la sostiene el motor: no hay trigger ni validación de aplicación
-- que se pueda olvidar.
CREATE TABLE usuario_empresa_rol (
  usuario_id      uuid        NOT NULL,
  empresa_id      uuid        NOT NULL,
  rol_codigo      text        NOT NULL REFERENCES rol (codigo),
  tenant_id       uuid        NOT NULL REFERENCES tenant (id),
  asignado_por_id uuid        REFERENCES usuario (id),
  asignado_en     timestamptz NOT NULL DEFAULT now(),
  revocado_en     timestamptz,

  PRIMARY KEY (usuario_id, empresa_id, rol_codigo),
  FOREIGN KEY (usuario_id, tenant_id) REFERENCES usuario (id, tenant_id),
  FOREIGN KEY (empresa_id, tenant_id) REFERENCES empresa (id, tenant_id)
);

COMMENT ON COLUMN usuario_empresa_rol.revocado_en IS
  'Un permiso se revoca, no se borra: queda el rastro de quien tuvo acceso y hasta cuando.';

CREATE INDEX ix_uer_usuario ON usuario_empresa_rol (usuario_id) WHERE revocado_en IS NULL;
CREATE INDEX ix_uer_empresa ON usuario_empresa_rol (empresa_id) WHERE revocado_en IS NULL;

-- -----------------------------------------------------------------------------
-- Login: la única puerta que atraviesa RLS, y es de solo lectura
-- -----------------------------------------------------------------------------
-- Al autenticar todavía no hay tenant en sesión, así que RLS taparía la fila.
-- En vez de darle BYPASSRLS a la conexión de la API, se abre esta función
-- SECURITY DEFINER: devuelve exactamente lo que el login necesita y nada más.
CREATE OR REPLACE FUNCTION fn_usuario_para_login(p_email citext)
RETURNS TABLE (
  id            uuid,
  tenant_id     uuid,
  hash_password text,
  activo        boolean,
  tenant_estado text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT u.id, u.tenant_id, u.hash_password, u.activo, t.estado
  FROM usuario u
  JOIN tenant  t ON t.id = u.tenant_id
  WHERE u.email = p_email;
$$;

REVOKE ALL ON FUNCTION fn_usuario_para_login(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_usuario_para_login(citext) TO gestion_app;

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
ALTER TABLE usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_usuario_aislado ON usuario
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE usuario_empresa_rol ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_empresa_rol FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_uer_aislado ON usuario_empresa_rol
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT ON rol TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON usuario             TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON usuario_empresa_rol TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON rol                 TO gestion_provision;

