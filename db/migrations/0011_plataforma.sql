-- =============================================================================
-- 0011_plataforma — quién administra el producto, no las contabilidades
-- =============================================================================
-- El administrador de la plataforma NO es una fila de `usuario`. Dos razones:
--
--  1. `usuario.tenant_id` es NOT NULL. Un administrador del producto no pertenece
--     a ninguna cuenta: si se le inventara una, aparecería en el listado de
--     usuarios de ese cliente.
--  2. Separarlos acota el daño. Un error en el login de clientes no alcanza estas
--     credenciales, y al revés.
--
-- Lo que este administrador puede hacer está deliberadamente acotado: crear
-- cuentas, empresas y el primer usuario de cada una, y suspender a quien no
-- pague. NO puede entrar a una contabilidad: no existe forma de emitirle un token
-- con empresa, así que no hay puerta hacia los datos contables de un cliente.

CREATE TABLE plataforma_admin (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext      NOT NULL UNIQUE
                               CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
  nombre_completo  text        NOT NULL,
  hash_password    text        NOT NULL,
  activo           boolean     NOT NULL DEFAULT true,
  ultimo_acceso_en timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz
);

COMMENT ON TABLE plataforma_admin IS
  'Administradores del producto. No pertenecen a ningun tenant y no pueden entrar a una contabilidad.';

CREATE TRIGGER tg_plataforma_admin_actualizado
  BEFORE UPDATE ON plataforma_admin
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- Sin RLS: la tabla no tiene datos de ningun cliente, y las politicas se apoyan
-- en `app.tenant_id`, que en una sesion de plataforma vale NULL a proposito.
--
-- La API necesita leerla para autenticar y marcarle el ultimo acceso. Crear
-- administradores es un acto de instalacion: solo `gestion_provision`, desde la
-- maquina donde corre el servidor.
GRANT SELECT, UPDATE ON plataforma_admin TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON plataforma_admin TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Rastro de lo que hace la plataforma sobre una cuenta
-- -----------------------------------------------------------------------------
-- Quien administra el producto toca cuentas ajenas. Suspender a un cliente o
-- crearle una empresa son actos que alguien tiene que poder revisar después, y
-- por eso quedan registrados con nombre propio.
CREATE TABLE plataforma_bitacora (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid        NOT NULL REFERENCES plataforma_admin (id),
  accion      text        NOT NULL CHECK (accion IN (
                'CREAR_CUENTA',
                'CREAR_EMPRESA',
                'CREAR_USUARIO',
                'CAMBIAR_ESTADO',
                'CAMBIAR_PLAN')),
  tenant_id   uuid        REFERENCES tenant (id),
  detalle     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ocurrido_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_bitacora_tenant ON plataforma_bitacora (tenant_id, ocurrido_en DESC);
CREATE INDEX ix_bitacora_admin ON plataforma_bitacora (admin_id, ocurrido_en DESC);

-- La bitacora solo agrega: no se edita ni se borra. Un rastro que se puede
-- reescribir no sirve para lo que existe.
GRANT SELECT, INSERT ON plataforma_bitacora TO gestion_app, gestion_provision;
